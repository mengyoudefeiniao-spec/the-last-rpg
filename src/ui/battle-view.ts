import type {
  BattleLogEntry,
  BattlePhase,
  BattleUnit,
  CommandId,
  PendingAction,
} from '../data/types.ts';
import type { BattleStage } from '../render/battle-stage.ts';
import type { Battle } from '../systems/battle/battle.ts';
import { isAlive } from '../systems/battle/battle-unit.ts';
import { COMMAND_ORDER, checkUsable, getCommand } from '../systems/battle/commands.ts';

/** 阶段的中文名，显示在顶栏。 */
const PHASE_LABELS: Record<BattlePhase, string> = {
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

/**
 * 演出速度档位。
 * 十人一回合的演出在 1 倍速下约 8 秒，容易让人以为卡住，所以默认给「快」。
 */
const SPEED_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '慢', value: 0.6 },
  { label: '常规', value: 1 },
  { label: '快', value: 2 },
  { label: '极快', value: 3.5 },
];

const DEFAULT_SPEED = 2;

/** 日志面板最多保留的条数。 */
const LOG_LIMIT = 80;

export interface BattleViewOptions {
  /** 点击「重新开始」时调用。 */
  onRestart?: () => void;
}

/**
 * 战斗 HUD：顶栏、指令栏、日志。
 *
 * 单位本身由 BattleStage 用 three.js 画在 3D 战场里，这里只管外围界面，
 * 并把「当前是谁在下指令」「是否在等选目标」同步给舞台去高亮。
 */
export class BattleView {
  private readonly root: HTMLElement;
  private readonly battle: Battle;
  private readonly onRestart: (() => void) | undefined;

  private readonly turnEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly cameraHintEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly commandsEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly speedButtons: HTMLElement[];

  private stage: BattleStage | undefined;
  private speed = DEFAULT_SPEED;

  /** 本回合已下达的指令。 */
  private pending: PendingAction[] = [];
  /** 正在为第几个我方单位下指令。 */
  private pickIndex = 0;
  /** 正在等待选择目标的那条指令。 */
  private awaitingTarget: CommandId | null = null;
  /** 已经渲染过的日志条数，用于增量追加。 */
  private renderedLog = 0;

  private readonly disposers: Array<() => void> = [];

  constructor(root: HTMLElement, battle: Battle, options: BattleViewOptions = {}) {
    this.root = root;
    this.battle = battle;
    this.onRestart = options.onRestart;

    const speedButtonsHtml = SPEED_PRESETS.map(
      (preset) => `<button type="button" data-speed="${preset.value}">${preset.label}</button>`,
    ).join('');

    root.innerHTML = `
      <div class="game">
        <header class="game__header">
          <span class="game__turn">第 0 回合</span>
          <span class="game__phase"></span>
          <span class="game__camera-hint"></span>
          <div class="game__speed" title="行动演出速度">${speedButtonsHtml}</div>
          <button type="button" class="game__restart">重新开始</button>
        </header>
        <div class="game__stage"></div>
        <aside class="game__aside">
          <h2 class="game__aside-title">战斗日志</h2>
          <div class="game__log"></div>
        </aside>
        <footer class="game__footer">
          <div class="game__hint"></div>
          <div class="game__commands"></div>
        </footer>
      </div>`;

    this.turnEl = pick(root, '.game__turn');
    this.phaseEl = pick(root, '.game__phase');
    this.cameraHintEl = pick(root, '.game__camera-hint');
    this.stageEl = pick(root, '.game__stage');
    this.hintEl = pick(root, '.game__hint');
    this.commandsEl = pick(root, '.game__commands');
    this.logEl = pick(root, '.game__log');
    this.speedButtons = [...root.querySelectorAll<HTMLElement>('.game__speed [data-speed]')];

    this.bindEvents();

    this.disposers.push(
      battle.events.on('phase', (phase) => {
        if (phase === 'commandInput') this.resetCommands();
        this.render();
      }),
      battle.events.on('log', () => this.renderLog()),
      battle.events.on('update', () => this.render()),
    );

    this.render();
  }

  /** 3D 战场要挂进这个容器。 */
  get stageContainer(): HTMLElement {
    return this.stageEl;
  }

  /** 接上 3D 舞台，之后才能同步高亮、视角开关与演出速度。 */
  attachStage(stage: BattleStage): void {
    this.stage = stage;
    this.applySpeed();
    this.syncStage();
  }

  /** 解除对 Battle 的订阅。旧界面被替换时必须调用。 */
  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  /** 由 3D 舞台的射线拾取回调：玩家点了某个单位。 */
  pickTarget(unitId: string): void {
    if (!this.awaitingTarget) return;

    const unit = this.battle.units.find((candidate) => candidate.id === unitId);
    if (!unit || unit.side !== 'enemy' || !isAlive(unit)) return;

    const actor = this.currentUnit();
    if (!actor) return;

    this.commitAction({ actorId: actor.id, commandId: this.awaitingTarget, targetId: unit.id });
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

  private bindEvents(): void {
    this.commandsEl.addEventListener('click', (event) => {
      const button = closestFrom(event, '[data-command]');
      const commandId = button?.dataset.command as CommandId | undefined;
      if (commandId) this.onCommandClick(commandId);
    });

    this.hintEl.addEventListener('click', (event) => {
      if (closestFrom(event, '[data-action="cancel-target"]')) {
        this.awaitingTarget = null;
        this.render();
      }
    });

    pick(this.root, '.game__speed').addEventListener('click', (event) => {
      const button = closestFrom(event, '[data-speed]');
      const value = Number(button?.dataset.speed);
      if (!Number.isFinite(value) || value <= 0) return;
      this.speed = value;
      this.applySpeed();
      this.renderSpeed();
    });

    pick(this.root, '.game__restart').addEventListener('click', () => {
      this.onRestart?.();
    });
  }

  private onCommandClick(commandId: CommandId): void {
    if (this.battle.phase !== 'commandInput') return;

    const actor = this.currentUnit();
    if (!actor) return;

    const def = getCommand(commandId);
    if (!checkUsable(actor, def).ok) return;

    if (def.requiresTarget) {
      this.awaitingTarget = commandId;
      this.render();
      return;
    }

    this.commitAction({ actorId: actor.id, commandId });
  }

  /** 记录一条指令；全队选完就交给 Battle 推进（异步，期间界面自动锁住）。 */
  private commitAction(action: PendingAction): void {
    this.pending.push(action);
    this.awaitingTarget = null;
    this.pickIndex += 1;

    if (this.pickIndex >= this.unitsToCommand().length) {
      const actions = this.pending.slice();
      this.battle.submit(actions).catch((error: unknown) => {
        console.error('[battle] 推进失败', error);
      });
    } else {
      this.render();
    }
  }

  private resetCommands(): void {
    this.pending = [];
    this.pickIndex = 0;
    this.awaitingTarget = null;
  }

  private unitsToCommand(): BattleUnit[] {
    return this.battle.awaitingUnits;
  }

  private currentUnit(): BattleUnit | undefined {
    return this.unitsToCommand()[this.pickIndex];
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
  // 渲染
  // -------------------------------------------------------------------------

  private render(): void {
    const { battle } = this;

    this.turnEl.textContent = `第 ${battle.turn} 回合`;
    this.phaseEl.textContent = `阶段：${PHASE_LABELS[battle.phase]}`;
    this.cameraHintEl.textContent =
      battle.phase === 'commandInput' && !battle.finished
        ? '可拖动旋转视角 · 滚轮缩放'
        : '';

    this.commandsEl.innerHTML = this.renderCommands();
    this.hintEl.innerHTML = this.renderHint();
    this.renderLog();
    this.renderSpeed();
    this.syncStage();
  }

  /** 把当前交互状态同步给 3D 舞台：视角开关、可点目标、当前操作者。 */
  private syncStage(): void {
    const stage = this.stage;
    if (!stage) return;

    const canCommand = this.battle.phase === 'commandInput' && !this.battle.finished;
    stage.setInteractive(canCommand);
    stage.setTargetable(this.awaitingTarget !== null);
    stage.setActiveUnit(this.currentUnit()?.id);
  }

  private renderCommands(): string {
    const actor = this.currentUnit();

    return COMMAND_ORDER.map((id) => {
      const def = getCommand(id);
      const usable = actor
        ? checkUsable(actor, def)
        : { ok: false, reason: '当前没有可操作的单位' };

      const classes = ['cmd'];
      if (!usable.ok) classes.push('cmd--disabled');
      if (def.placeholder) classes.push('cmd--placeholder');
      if (this.awaitingTarget === id) classes.push('cmd--armed');

      const cost = formatCost(def);
      return `
        <button type="button" class="${classes.join(' ')}" data-command="${id}"
                ${usable.ok ? '' : 'disabled'}
                title="${escapeHtml(usable.reason ?? def.desc)}">
          <span class="cmd__label">${def.label}${def.placeholder ? '<i class="cmd__flag">占位</i>' : ''}</span>
          <span class="cmd__cost">${cost}</span>
        </button>`;
    }).join('');
  }

  private renderHint(): string {
    const result = this.battle.result;
    if (result) {
      const text =
        result.outcome === 'victory'
          ? `战斗胜利！用了 ${result.turns} 个回合。`
          : result.outcome === 'defeat'
            ? `全员倒下，战斗失败（坚持了 ${result.turns} 个回合）。`
            : `成功脱离战斗（第 ${result.turns} 回合）。`;
      return `<span class="hint hint--done">${text} 点「重新开始」再打一场。</span>`;
    }

    if (this.battle.phase !== 'commandInput') {
      return `<span class="hint">${PHASE_LABELS[this.battle.phase]}…</span>`;
    }

    const actor = this.currentUnit();
    if (!actor) return '<span class="hint">等待指令…</span>';

    if (this.awaitingTarget) {
      const def = getCommand(this.awaitingTarget);
      return `
        <span class="hint"><b>${escapeHtml(actor.name)}</b> 使用「${def.label}」—— 点击场上的敌人作为目标</span>
        <button type="button" class="hint__cancel" data-action="cancel-target">取消</button>`;
    }

    const total = this.unitsToCommand().length;
    return `<span class="hint">轮到 <b>${escapeHtml(actor.name)}</b> 下达指令（${this.pickIndex + 1} / ${total}）</span>`;
  }

  /** 增量追加日志：一场战斗上百条，全量重建会丢掉滚动位置。 */
  private renderLog(): void {
    while (this.renderedLog < this.battle.log.length) {
      const entry = this.battle.log[this.renderedLog] as BattleLogEntry;
      this.renderedLog += 1;

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

/** 从事件目标向上找最近的匹配元素，用于事件委托。 */
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
