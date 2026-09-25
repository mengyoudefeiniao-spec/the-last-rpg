import type {
  BattleLogEntry,
  BattlePhase,
  BattleUnit,
  CommandId,
  PendingAction,
} from '../data/types.ts';
import type { Battle } from '../systems/battle/battle.ts';
import { isAlive } from '../systems/battle/battle-unit.ts';
import { COMMAND_ORDER, checkUsable, getCommand } from '../systems/battle/commands.ts';

/** 阶段的中文名，显示在顶栏与提示条。 */
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

/** 日志面板最多保留的条数。 */
const LOG_LIMIT = 80;

export interface BattleViewOptions {
  /** 点击「重新开始」时调用。 */
  onRestart?: () => void;
}

/**
 * 战斗界面。
 *
 * 只订阅 Battle 的事件、只读它的状态 —— 战斗逻辑对 DOM 一无所知（见 src/README.md 的依赖方向）。
 * 指令收集流程：为每个存活的我方单位依次选指令 → 需要目标的指令再点敌人 → 全部选完自动提交。
 */
export class BattleView {
  private readonly root: HTMLElement;
  private readonly battle: Battle;
  private readonly onRestart: (() => void) | undefined;

  private readonly turnEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly fieldEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly commandsEl: HTMLElement;
  private readonly logEl: HTMLElement;

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

    // 骨架只建一次：日志容器必须保留，才能做增量追加。
    root.innerHTML = `
      <div class="battle">
        <header class="battle__header">
          <span class="battle__turn">第 0 回合</span>
          <span class="battle__phase"></span>
          <button type="button" class="battle__restart">重新开始</button>
        </header>
        <div class="battle__body">
          <div class="battle__field"></div>
          <aside class="battle__aside">
            <h2 class="battle__aside-title">战斗日志</h2>
            <div class="battle__log"></div>
          </aside>
        </div>
        <footer class="battle__footer">
          <div class="battle__hint"></div>
          <div class="battle__commands"></div>
        </footer>
      </div>`;

    this.turnEl = pick(root, '.battle__turn');
    this.phaseEl = pick(root, '.battle__phase');
    this.fieldEl = pick(root, '.battle__field');
    this.hintEl = pick(root, '.battle__hint');
    this.commandsEl = pick(root, '.battle__commands');
    this.logEl = pick(root, '.battle__log');

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

  /** 解除对 Battle 的订阅。旧界面被替换时必须调用，否则旧战斗仍会驱动已废弃的 DOM。 */
  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

  private bindEvents(): void {
    this.fieldEl.addEventListener('click', (event) => {
      const card = closestFrom(event, '[data-unit-id]');
      const unitId = card?.dataset.unitId;
      if (!unitId) return;
      const unit = this.battle.units.find((candidate) => candidate.id === unitId);
      if (unit) this.onUnitClick(unit);
    });

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

    pick(this.root, '.battle__restart').addEventListener('click', () => {
      this.onRestart?.();
    });
  }

  private onUnitClick(unit: BattleUnit): void {
    if (!this.awaitingTarget) return;
    if (unit.side !== 'enemy' || !isAlive(unit)) return;

    const actor = this.currentUnit();
    if (!actor) return;

    this.commitAction({ actorId: actor.id, commandId: this.awaitingTarget, targetId: unit.id });
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

  /** 记录一条指令，若全队都选完就提交给 Battle。 */
  private commitAction(action: PendingAction): void {
    this.pending.push(action);
    this.awaitingTarget = null;
    this.pickIndex += 1;

    if (this.pickIndex >= this.unitsToCommand().length) {
      const actions = this.pending.slice();
      this.resetCommands();
      this.battle.submit(actions);
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

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private render(): void {
    this.turnEl.textContent = `第 ${this.battle.turn} 回合`;
    this.phaseEl.textContent = `阶段：${PHASE_LABELS[this.battle.phase]}`;

    this.fieldEl.innerHTML = this.renderField();
    this.commandsEl.innerHTML = this.renderCommands();
    this.hintEl.innerHTML = this.renderHint();
    this.renderLog();
  }

  private renderField(): string {
    const enemies = this.battle.units.filter((unit) => unit.side === 'enemy');
    const allies = this.battle.units.filter((unit) => unit.side === 'ally');

    return `
      <section class="side side--enemy">
        <h2 class="side__title">敌方</h2>
        <div class="side__units">${enemies.map((unit) => this.unitCard(unit)).join('')}</div>
      </section>
      <section class="side side--ally">
        <h2 class="side__title">我方</h2>
        <div class="side__units">${allies.map((unit) => this.unitCard(unit)).join('')}</div>
      </section>`;
  }

  private unitCard(unit: BattleUnit): string {
    const { hp, maxHp, mp, maxMp, sp, maxSp } = unit.stats;
    const alive = isAlive(unit);

    const classes = ['unit', `unit--${unit.side}`];
    if (!alive) classes.push('unit--down');
    if (unit.isDefending) classes.push('unit--defending');
    if (this.currentUnit()?.id === unit.id) classes.push('unit--active');
    if (this.awaitingTarget && unit.side === 'enemy' && alive) classes.push('unit--targetable');

    const tags: string[] = [];
    if (unit.isDefending) tags.push('<span class="unit__tag">防御中</span>');
    if (unit.captured) tags.push('<span class="unit__tag">已捕获</span>');
    if (!alive && !unit.captured) tags.push('<span class="unit__tag unit__tag--down">已倒下</span>');

    const statuses = unit.statuses
      .map(
        (status) =>
          `<span class="status status--${status.def.kind}" title="${escapeHtml(status.def.desc)}">${escapeHtml(status.def.name)}·${status.remaining}</span>`,
      )
      .join('');

    return `
      <article class="${classes.join(' ')}" data-unit-id="${escapeHtml(unit.id)}">
        <div class="unit__head">
          <span class="unit__name">${escapeHtml(unit.name)}</span>
          ${tags.join('')}
        </div>
        ${bar('hp', 'HP', hp, maxHp)}
        ${bar('mp', 'MP', mp, maxMp)}
        ${bar('sp', '愤怒', sp, maxSp)}
        ${statuses ? `<div class="unit__statuses">${statuses}</div>` : ''}
      </article>`;
  }

  private renderCommands(): string {
    const actor = this.currentUnit();

    return COMMAND_ORDER.map((id) => {
      const def = getCommand(id);
      const usable = actor ? checkUsable(actor, def) : { ok: false, reason: '当前没有可操作的单位' };

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
        <span class="hint"><b>${escapeHtml(actor.name)}</b> 使用「${def.label}」—— 点击一个敌人作为目标</span>
        <button type="button" class="hint__cancel" data-action="cancel-target">取消</button>`;
    }

    const total = this.unitsToCommand().length;
    return `<span class="hint">轮到 <b>${escapeHtml(actor.name)}</b> 下达指令（${this.pickIndex + 1} / ${total}）</span>`;
  }

  /** 增量追加日志：一次战斗可能产生上百条，全量重建会丢掉滚动位置。 */
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

function bar(kind: 'hp' | 'mp' | 'sp', label: string, value: number, max: number): string {
  const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `
    <div class="bar bar--${kind}">
      <div class="bar__fill" style="width:${percent.toFixed(1)}%"></div>
      <span class="bar__text">${label} ${Math.max(0, value)} / ${max}</span>
    </div>`;
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
