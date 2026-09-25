import { listBattlefields } from '../../shared/data/battlefields.ts';
import { listEnvironments, listWeathers } from '../../shared/data/environments.ts';
import { listFormations } from '../../shared/data/formations.ts';
import { DEMO_EVENT_ID } from '../../shared/data/stage-events.ts';
import type { BattlePhase, CommandId, PendingAction, TerrainZone } from '../../shared/data/types.ts';
import type { UnitSnapshot } from '../../shared/protocol.ts';
import { COMMAND_ORDER, getCommand } from '../../shared/systems/battle/commands.ts';
import { zoneAt } from '../../shared/systems/battle/terrain.ts';
import type { ClientStatus } from '../net/battle-client.ts';
import type { BattleStage } from '../render/battle-stage.ts';
import type { BattleMirror } from '../state/battle-mirror.ts';

/** 阶段的中文名，显示在顶栏。 */
const PHASE_LABELS: Record<BattlePhase, string> = {
  deployment: '布阵',
  turnStart: '回合开始',
  commandInput: '选择指令',
  statusSettlement: '状态结算',
  executeCommands: '执行玩家指令',
  bothSidesAction: '敌我双方行动',
  actionEnd: '行动结束判定',
  victory: '战斗胜利',
  defeat: '战斗失败',
  fled: '已脱离战斗',
};

/** 演出速度档位。十人一回合在 1 倍速下约 8 秒，默认给「快」。 */
const SPEED_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '慢', value: 0.6 },
  { label: '常规', value: 1 },
  { label: '快', value: 2 },
  { label: '极快', value: 3.5 },
];

const DEFAULT_SPEED = 2;
const LOG_LIMIT = 80;

/** 队伍配置的四个字段 —— 也就是战斗外能改的全部东西。 */
export interface PartyConfigPatch {
  formationId?: string;
  battlefieldId?: string;
  environmentId?: string;
  weatherId?: string;
}

/** 界面能发起的意图。它们都会被转成协议消息发给服务端 —— 界面自己不改任何状态。 */
export interface BattleViewActions {
  onBeginBattle: () => void;
  onSubmit: (actions: PendingAction[]) => void;
  onRestart: () => void;
  /** 保存队伍配置（阵法 / 战场 / 环境 / 天气）并重开一局。 */
  onSavePartyConfig: (patch: PartyConfigPatch) => void;
  /** 手动触发一个剧情事件（演示用）。 */
  onTriggerEvent: (eventId: string) => void;
}

/**
 * 战斗 HUD：顶栏、布阵面板 / 指令栏、日志、队伍配置弹窗。
 *
 * 它只读 BattleMirror 并把玩家意图交给 actions —— 既不推导战斗，也不保存状态。
 * 单位与阵图由 BattleStage 画在 3D 战场里，这里只把「当前谁能操作」同步过去做高亮。
 */
export class BattleView {
  private readonly root: HTMLElement;
  private readonly mirror: BattleMirror;
  private readonly actions: BattleViewActions;

  private readonly turnEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly formationEl: HTMLElement;
  private readonly sceneryEl: HTMLElement;
  private readonly connectionEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly overlayEl: HTMLElement;
  private readonly dialogEl: HTMLElement;
  private readonly speedButtons: HTMLElement[];

  private stage: BattleStage | undefined;
  private speed = DEFAULT_SPEED;

  /** 本回合已下达的指令。 */
  private pending: PendingAction[] = [];
  private pickIndex = 0;
  private awaitingTarget: CommandId | null = null;
  private renderedLog = 0;
  private renderedSession = '';

  /** 配置弹窗里未提交的选择。关闭时丢弃。 */
  private draft: PartyConfigPatch = {};

  constructor(root: HTMLElement, mirror: BattleMirror, actions: BattleViewActions) {
    this.root = root;
    this.mirror = mirror;
    this.actions = actions;

    const speedButtonsHtml = SPEED_PRESETS.map(
      (preset) => `<button type="button" data-speed="${preset.value}">${preset.label}</button>`,
    ).join('');

    root.innerHTML = `
      <div class="game">
        <header class="game__header">
          <span class="game__turn">连接中…</span>
          <span class="game__phase"></span>
          <span class="game__formation"></span>
          <span class="game__scenery"></span>
          <span class="game__connection"></span>
          <button type="button" class="game__event" title="演示：从上方事件区降下一道渡劫天雷">⚡ 天雷</button>
          <div class="game__speed" title="行动演出速度">${speedButtonsHtml}</div>
          <button type="button" class="game__config">队伍配置</button>
          <button type="button" class="game__restart">重开一局</button>
        </header>
        <div class="game__stage"></div>
        <aside class="game__aside">
          <h2 class="game__aside-title">战斗日志</h2>
          <div class="game__log"></div>
        </aside>
        <footer class="game__footer">
          <div class="game__hint"></div>
          <div class="game__panel"></div>
        </footer>
      </div>
      <div class="config-overlay" hidden>
        <div class="config-dialog" role="dialog" aria-label="队伍配置"></div>
      </div>`;

    this.turnEl = pick(root, '.game__turn');
    this.phaseEl = pick(root, '.game__phase');
    this.formationEl = pick(root, '.game__formation');
    this.sceneryEl = pick(root, '.game__scenery');
    this.connectionEl = pick(root, '.game__connection');
    this.stageEl = pick(root, '.game__stage');
    this.hintEl = pick(root, '.game__hint');
    this.panelEl = pick(root, '.game__panel');
    this.logEl = pick(root, '.game__log');
    this.overlayEl = pick(root, '.config-overlay');
    this.dialogEl = pick(root, '.config-dialog');
    this.speedButtons = [...root.querySelectorAll<HTMLElement>('.game__speed [data-speed]')];

    this.bindEvents();
    this.refresh();
  }

  /** 3D 战场要挂进这个容器。 */
  get stageContainer(): HTMLElement {
    return this.stageEl;
  }

  attachStage(stage: BattleStage): void {
    this.stage = stage;
    this.applySpeed();
    this.syncStage();
  }

  destroy(): void {
    this.stage = undefined;
  }

  /** 每次收到服务端快照后由外部调用。 */
  refresh(): void {
    const mirror = this.mirror;

    this.turnEl.textContent =
      mirror.phase === 'deployment' ? '布阵阶段' : `第 ${mirror.turn} 回合`;
    this.phaseEl.textContent = `阶段：${PHASE_LABELS[mirror.phase]}`;
    this.formationEl.textContent = mirror.formation ? `阵：${mirror.formation.name}` : '';
    this.sceneryEl.textContent = mirror.scenery
      ? `${mirror.scenery.environment.name} · ${mirror.scenery.weather.name}`
      : '';

    this.renderHint();
    this.renderPanel();
    this.renderLog();
    this.renderSpeed();
    this.renderDialog();
    this.syncStage();
  }

  setConnectionStatus(status: ClientStatus, detail?: string): void {
    const text =
      status === 'open'
        ? '已连接'
        : status === 'connecting'
          ? '连接中…'
          : (detail ?? '已断开');
    this.connectionEl.textContent = text;
    this.connectionEl.className = `game__connection game__connection--${status}`;
  }

  showError(message: string): void {
    this.hintEl.innerHTML = `<span class="hint hint--error">服务端拒绝：${escapeHtml(message)}</span>`;
  }

  /** 3D 舞台的拾取回调：只有选目标这一种用途了（站位由阵法定，不再点人换位）。 */
  pickUnit(unitId: string): void {
    if (this.mirror.playing || !this.awaitingTarget) return;

    const unit = this.mirror.unitById(unitId);
    if (!unit || unit.side !== 'enemy' || !unit.alive) return;

    const actor = this.currentUnit();
    if (!actor) return;

    this.commitAction({ actorId: actor.id, commandId: this.awaitingTarget, targetId: unit.id });
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

  private bindEvents(): void {
    this.panelEl.addEventListener('click', (event) => {
      const commandButton = closestFrom(event, '[data-command]');
      const commandId = commandButton?.dataset.command as CommandId | undefined;
      if (commandId) {
        this.onCommandClick(commandId);
        return;
      }

      if (closestFrom(event, '[data-action="begin-battle"]')) {
        this.actions.onBeginBattle();
      }
    });

    this.hintEl.addEventListener('click', (event) => {
      if (closestFrom(event, '[data-action="cancel-target"]')) {
        this.awaitingTarget = null;
        this.refresh();
      }
    });

    pick(this.root, '.game__speed').addEventListener('click', (event) => {
      const value = Number(closestFrom(event, '[data-speed]')?.dataset.speed);
      if (!Number.isFinite(value) || value <= 0) return;
      this.speed = value;
      this.applySpeed();
      this.renderSpeed();
    });

    pick(this.root, '.game__config').addEventListener('click', () => this.openConfig());
    pick(this.root, '.game__restart').addEventListener('click', () => {
      this.actions.onRestart();
    });

    pick(this.root, '.game__event').addEventListener('click', () => {
      this.actions.onTriggerEvent(DEMO_EVENT_ID);
    });

    // 弹窗：选项点击与底部按钮都走委托
    this.overlayEl.addEventListener('click', (event) => {
      if (event.target === this.overlayEl) {
        this.closeConfig();
        return;
      }

      const option = closestFrom(event, '[data-config-field]');
      if (option) {
        const field = option.dataset.configField as keyof PartyConfigPatch | undefined;
        const value = option.dataset.configValue;
        if (field && value) {
          this.draft = { ...this.draft, [field]: value };
          this.renderDialog();
        }
        return;
      }

      if (closestFrom(event, '[data-action="config-close"]')) {
        this.closeConfig();
        return;
      }

      if (closestFrom(event, '[data-action="config-apply"]')) {
        this.actions.onSavePartyConfig(this.draft);
        this.closeConfig();
      }
    });
  }

  private onCommandClick(commandId: CommandId): void {
    if (this.mirror.phase !== 'commandInput' || this.mirror.playing) return;

    const actor = this.currentUnit();
    if (!actor) return;
    if (!this.availabilityOf(actor, commandId).ok) return;

    const def = getCommand(commandId);
    if (def.requiresTarget) {
      this.awaitingTarget = commandId;
      this.refresh();
      return;
    }

    this.commitAction({ actorId: actor.id, commandId });
  }

  private commitAction(action: PendingAction): void {
    this.pending.push(action);
    this.awaitingTarget = null;
    this.pickIndex += 1;

    if (this.pickIndex >= this.unitsToCommand().length) {
      const actions = this.pending.slice();
      this.pending = [];
      this.pickIndex = 0;
      this.actions.onSubmit(actions);
    } else {
      this.refresh();
    }
  }

  private unitsToCommand(): UnitSnapshot[] {
    return this.mirror.awaitingUnits;
  }

  private currentUnit(): UnitSnapshot | undefined {
    return this.unitsToCommand()[this.pickIndex];
  }

  private availabilityOf(unit: UnitSnapshot, id: CommandId): { ok: boolean; reason?: string } {
    const found = unit.commands?.find((entry) => entry.id === id);
    if (found) return found;
    return { ok: false, reason: '服务端未下发该指令的可用性' };
  }

  private applySpeed(): void {
    this.stage?.setSpeed(this.speed);
  }

  private renderSpeed(): void {
    for (const button of this.speedButtons) {
      button.classList.toggle('is-on', Number(button.dataset.speed) === this.speed);
    }
  }

  // -------------------------------------------------------------------------
  // 队伍配置弹窗
  // -------------------------------------------------------------------------

  private openConfig(): void {
    // 以当前生效的配置为草稿起点
    const mirror = this.mirror;
    this.draft = {
      formationId: mirror.formation?.id,
      battlefieldId: mirror.battlefield?.id,
      environmentId: mirror.scenery?.environment.id,
      weatherId: mirror.scenery?.weather.id,
    };
    this.overlayEl.hidden = false;
    this.renderDialog();
  }

  private closeConfig(): void {
    this.overlayEl.hidden = true;
    this.draft = {};
  }

  /**
   * 配置弹窗。
   *
   * 这些是**战斗外**的设定，所以改动不能热应用 —— 点「应用并重开一局」会换一场仗。
   * 将来它会被菜单里的设置页取代，这里只是临时入口。
   */
  private renderDialog(): void {
    if (this.overlayEl.hidden) return;

    const current = { ...this.configFromMirror(), ...this.draft };

    const section = (
      title: string,
      field: keyof PartyConfigPatch,
      options: ReadonlyArray<{ id: string; name: string; desc: string }>,
    ): string => `
      <section class="config-section">
        <h3>${title}</h3>
        <div class="config-options">
          ${options
            .map(
              (option) => `
            <button type="button"
                    class="config-option${current[field] === option.id ? ' is-on' : ''}"
                    data-config-field="${field}"
                    data-config-value="${escapeHtml(option.id)}"
                    title="${escapeHtml(option.desc)}">
              <span class="config-option__name">${escapeHtml(option.name)}</span>
              <span class="config-option__desc">${escapeHtml(option.desc)}</span>
            </button>`,
            )
            .join('')}
        </div>
      </section>`;

    this.dialogEl.innerHTML = `
      <header class="config-dialog__head">
        <h2>队伍配置</h2>
        <p>阵法与场景都是战斗外的设定 —— 应用之后会按新配置重开一局。</p>
      </header>
      ${section('我方阵法', 'formationId', listFormations())}
      ${section('战场', 'battlefieldId', listBattlefields())}
      ${section('环境', 'environmentId', listEnvironments())}
      ${section('天气', 'weatherId', listWeathers())}
      <footer class="config-dialog__foot">
        <button type="button" data-action="config-close">取消</button>
        <button type="button" class="is-primary" data-action="config-apply">应用并重开一局</button>
      </footer>`;
  }

  private configFromMirror(): PartyConfigPatch {
    const mirror = this.mirror;
    return {
      formationId: mirror.formation?.id,
      battlefieldId: mirror.battlefield?.id,
      environmentId: mirror.scenery?.environment.id,
      weatherId: mirror.scenery?.weather.id,
    };
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private renderHint(): void {
    const mirror = this.mirror;

    if (mirror.phase === 'deployment') {
      const formation = mirror.formation;
      this.hintEl.innerHTML = `<span class="hint">布阵：当前摆的是「<b>${escapeHtml(
        formation?.name ?? '无阵',
      )}</b>」。阵位与地形效果都标在场上了 —— 要换阵法或场景，点右上角「队伍配置」。</span>`;
      return;
    }

    if (mirror.playing) {
      this.hintEl.innerHTML = '<span class="hint">演出中…</span>';
      return;
    }

    const result = mirror.result;
    if (result) {
      const text =
        result.outcome === 'victory'
          ? `战斗胜利！用了 ${result.turns} 个回合。`
          : result.outcome === 'defeat'
            ? `全员倒下，战斗失败（坚持了 ${result.turns} 个回合）。`
            : `成功脱离战斗（第 ${result.turns} 回合）。`;
      this.hintEl.innerHTML = `<span class="hint hint--done">${text} 点「重开一局」再打一场。</span>`;
      return;
    }

    if (mirror.phase !== 'commandInput') {
      this.hintEl.innerHTML = `<span class="hint">${PHASE_LABELS[mirror.phase]}…</span>`;
      return;
    }

    const actor = this.currentUnit();
    if (!actor) {
      this.hintEl.innerHTML = '<span class="hint">等待指令…</span>';
      return;
    }

    if (this.awaitingTarget) {
      const def = getCommand(this.awaitingTarget);
      this.hintEl.innerHTML = `
        <span class="hint"><b>${escapeHtml(actor.name)}</b> 使用「${def.label}」—— 点击场上的敌人作为目标</span>
        <button type="button" class="hint__cancel" data-action="cancel-target">取消</button>`;
      return;
    }

    const total = this.unitsToCommand().length;
    const role = actor.formationRole ? `（${escapeHtml(actor.formationRole)}）` : '';
    this.hintEl.innerHTML = `<span class="hint">轮到 <b>${escapeHtml(actor.name)}</b>${role} 下达指令（${this.pickIndex + 1} / ${total}）</span>`;
  }

  private renderPanel(): void {
    if (this.mirror.phase === 'deployment') {
      this.panelEl.className = 'game__panel game__panel--deploy';
      this.panelEl.innerHTML = this.renderDeployPanel();
      return;
    }

    this.panelEl.className = 'game__panel game__panel--commands';
    this.panelEl.innerHTML = this.renderCommands();
  }

  /**
   * 布阵面板：把阵法、阵位与落点一次摊开给玩家看。
   * 站位由阵法定死，这里不再是可操作项 —— 想调整只能回去换阵法。
   */
  private renderDeployPanel(): string {
    const formation = this.mirror.formation;

    const rows = this.mirror.allies
      .map((unit) => {
        const zone = this.zoneOf(unit);
        const zoneText = zone ? escapeHtml(zone.name) : '普通地面';
        const zoneClass = zone ? ` zone-tag--${zone.kind}` : '';
        return `
          <li class="deploy__unit">
            <span class="deploy__role">${escapeHtml(unit.formationRole ?? '—')}</span>
            <span class="deploy__name">${escapeHtml(unit.name)}</span>
            <span class="zone-tag${zoneClass}">${zoneText}</span>
          </li>`;
      })
      .join('');

    const zones = (this.mirror.battlefield?.zones ?? [])
      .map(
        (zone) =>
          `<li class="deploy__zone deploy__zone--${zone.kind}"><b>${escapeHtml(zone.name)}</b>：${escapeHtml(zone.desc)}</li>`,
      )
      .join('');

    return `
      <div class="deploy">
        <div class="deploy__head">
          <span class="deploy__formation">阵：${escapeHtml(formation?.name ?? '无阵')}</span>
          <span class="deploy__desc">${escapeHtml(formation?.desc ?? '')}</span>
        </div>
        <ul class="deploy__units">${rows}</ul>
        <button type="button" class="deploy__start" data-action="begin-battle">开始战斗</button>
      </div>
      <ul class="deploy__zones">${zones}</ul>`;
  }

  private renderCommands(): string {
    const actor = this.currentUnit();

    return COMMAND_ORDER.map((id) => {
      const def = getCommand(id);
      const availability = actor
        ? this.availabilityOf(actor, id)
        : { ok: false, reason: '当前没有可操作的单位' };

      const classes = ['cmd'];
      if (!availability.ok) classes.push('cmd--disabled');
      if (def.placeholder) classes.push('cmd--placeholder');
      if (this.awaitingTarget === id) classes.push('cmd--armed');

      return `
        <button type="button" class="${classes.join(' ')}" data-command="${id}"
                ${availability.ok ? '' : 'disabled'}
                title="${escapeHtml(availability.reason ?? def.desc)}">
          <span class="cmd__label">${def.label}${def.placeholder ? '<i class="cmd__flag">占位</i>' : ''}</span>
          <span class="cmd__cost">${formatCost(def)}</span>
        </button>`;
    }).join('');
  }

  private zoneOf(unit: UnitSnapshot): TerrainZone | undefined {
    const battlefield = this.mirror.battlefield;
    if (!battlefield) return undefined;
    return zoneAt(battlefield, unit.position);
  }

  /** 增量追加日志；换局（sessionId 变了）就从头来。 */
  private renderLog(): void {
    if (this.mirror.sessionId !== this.renderedSession) {
      this.renderedSession = this.mirror.sessionId;
      this.renderedLog = 0;
      this.logEl.replaceChildren();
    }

    if (this.mirror.log.length < this.renderedLog) {
      this.renderedLog = 0;
      this.logEl.replaceChildren();
    }

    while (this.renderedLog < this.mirror.log.length) {
      const entry = this.mirror.log[this.renderedLog];
      this.renderedLog += 1;
      if (!entry) continue;

      const line = document.createElement('div');
      line.className = `log__line log__line--${entry.kind}`;
      line.textContent = `[${entry.turn}] ${entry.text}`;
      this.logEl.appendChild(line);
    }

    while (this.logEl.childElementCount > LOG_LIMIT) {
      this.logEl.removeChild(this.logEl.firstChild as Node);
    }

    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** 把交互状态同步给 3D 舞台：视角开关、可点对象、当前操作者。 */
  private syncStage(): void {
    const stage = this.stage;
    if (!stage) return;

    const mirror = this.mirror;
    const idle = !mirror.playing;
    const canLook = idle && (mirror.phase === 'deployment' || mirror.phase === 'commandInput');
    stage.setInteractive(canLook);

    // 只剩「选目标」一种拾取用途了 —— 布阵阶段不点人
    stage.setPickMode(idle && this.awaitingTarget ? 'enemy' : 'none');
    stage.setActiveUnit(this.currentUnit()?.id);
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pick(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`战斗界面缺少必要节点：${selector}`);
  }
  return element;
}

function closestFrom(event: MouseEvent, selector: string): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const found = target.closest(selector);
  return found instanceof HTMLElement ? found : null;
}

function formatCost(def: { cost: { mp?: number; sp?: number } }): string {
  const parts: string[] = [];
  if (def.cost.mp) parts.push(`MP ${def.cost.mp}`);
  if (def.cost.sp) parts.push(`愤怒 ${def.cost.sp}`);
  return parts.length > 0 ? parts.join(' · ') : '无消耗';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
