import { BALANCE } from '../../config/balance.ts';
import { EventBus } from '../../core/event-bus.ts';
import { createRng, type Rng } from '../../core/rng.ts';
import type {
  BattleEvents,
  BattleLogEntry,
  BattleOutcome,
  BattlePhase,
  BattleResult,
  BattleUnit,
  CommandDef,
  LogKind,
  PendingAction,
  Side,
  StatKey,
  StatusDef,
  StatusTrigger,
} from '../../data/types.ts';
import { chooseAutoAllyAction, chooseEnemyAction } from './ai.ts';
import {
  applyDamage,
  enemiesOf,
  gainMp,
  gainSp,
  healHp,
  isAlive,
  resolveAttack,
  spendMp,
  spendSp,
  type DamageSpec,
} from './battle-unit.ts';
import { checkUsable, getCommand } from './commands.ts';
import {
  applyStatus,
  blockingStatus,
  collectStatusTicks,
  decrementDurations,
  effectiveStat,
  getStatusDef,
} from './status-effects.ts';

/** 一次伤害/治疗的结果，供表现层播受击、飘字、倒地。 */
export interface StrikeReport {
  /** 造成伤害的单位；DoT 之类没有攻击者时为 undefined。 */
  attacker: BattleUnit | undefined;
  target: BattleUnit;
  damage: number;
  healing: number;
  crit: boolean;
  defeated: boolean;
  label: string;
}

/** 状态施加的结果。 */
export interface StatusReport {
  unit: BattleUnit;
  name: string;
  kind: 'buff' | 'debuff';
}

/**
 * 表现层接口 —— 依赖倒置的关键。
 *
 * Battle 在这些节点暂停，等表现层演完再继续；不挂 director 时所有 await 直接跳过，
 * 战斗瞬间跑完 —— 这正是单元测试与自动战斗想要的。
 * 接口本身只涉及领域类型，不含任何 DOM 概念，所以逻辑层依然与渲染彻底解耦。
 */
export interface BattleDirector {
  /** 回合开始，可播回合横幅。 */
  onTurnStart?(turn: number): Promise<void> | void;
  /** 某个单位即将行动：可让角色移动到位、播前摇。 */
  beforeAction?(
    actor: BattleUnit,
    action: PendingAction,
    target: BattleUnit | undefined,
  ): Promise<void> | void;
  /** 每次伤害/治疗结算后。 */
  onStrike?(report: StrikeReport): Promise<void> | void;
  /** 状态施加后。 */
  onStatus?(report: StatusReport): Promise<void> | void;
  /** 行动结束：角色归位。 */
  afterAction?(actor: BattleUnit): Promise<void> | void;
}

export interface BattleOptions {
  units: BattleUnit[];
  /** 固定 seed 即可重放同一场战斗，便于复现 bug。 */
  seed?: number;
}

/** 属性键的展示顺序，日志里按这个顺序列增益减益。 */
const STAT_KEYS: readonly StatKey[] = ['atk', 'def', 'mag', 'res', 'spd'];

/**
 * 回合制战斗状态机。
 *
 * 一个回合的完整流程（与需求一一对应）：
 *
 *   1. turnStart        回合开始：自然回复、回合开始触发的状态结算
 *   2. commandInput     玩家选择指令（此处暂停，等待 UI 调用 submit）
 *   3. statusSettlement 状态结算：判定能否行动、汇总属性修正
 *   4. executeCommands  执行玩家指令：校验并固化；防御/逃跑立即生效
 *   5. bothSidesAction  敌我双方行动：按速度排序依次结算
 *   6. actionEnd        行动结束判定：DoT/HoT、状态倒计时与到期
 *   → 回到 1，直到一方全灭
 *
 * 类本身对 DOM 一无所知，只通过事件总线广播，并在挂了 director 时暂停等待演出。
 */
export class Battle {
  readonly units: BattleUnit[];
  readonly events = new EventBus<BattleEvents>();
  readonly log: BattleLogEntry[] = [];

  /** 表现层。可以在构造之后再挂上。 */
  director: BattleDirector | undefined;

  phase: BattlePhase = 'turnStart';
  turn = 0;
  result: BattleResult | null = null;

  private readonly rng: Rng;
  private pending: readonly PendingAction[] = [];
  private queued: PendingAction[] = [];
  /** 本回合被状态（眩晕等）禁止行动的单位 id。 */
  private blocked = new Set<string>();
  private fled = false;

  constructor(options: BattleOptions) {
    this.units = options.units;
    this.rng = createRng(options.seed ?? 0x5eed);
  }

  get finished(): boolean {
    return this.result !== null;
  }

  /** 当前等待玩家下达指令的单位；不在指令阶段则为空数组。 */
  get awaitingUnits(): BattleUnit[] {
    if (this.phase !== 'commandInput' || this.finished) return [];
    return this.survivorsOf('ally').filter((unit) => unit.isPlayerControlled);
  }

  /** 开始战斗：进入第 1 回合的指令阶段。 */
  async start(): Promise<void> {
    if (this.turn !== 0) throw new Error('战斗已经开始，请新建实例');
    await this.beginTurn();
    this.events.emit('update', undefined);
  }

  /**
   * 提交一整个回合的指令，并推进到下一个指令阶段（或战斗结束）。
   * 挂了 director 时会在每个动作点暂停，等演出播完。
   */
  async submit(actions: readonly PendingAction[]): Promise<void> {
    if (this.phase !== 'commandInput') {
      throw new Error(`当前阶段是 ${this.phase}，不接受指令`);
    }
    this.pending = [...actions];

    this.enterPhase('statusSettlement');
    this.runStatusSettlement();
    if (this.finishIfOver()) return;

    this.enterPhase('executeCommands');
    await this.runExecuteCommands();
    if (this.finishIfOver()) return;

    this.enterPhase('bothSidesAction');
    await this.runBothSidesAction();
    if (this.finishIfOver()) return;

    this.enterPhase('actionEnd');
    await this.runActionEnd();
    if (this.finishIfOver()) return;

    await this.beginTurn();
    this.events.emit('update', undefined);
  }

  /** 演示与测试用：为所有等待指令的我方单位生成一条合法指令。 */
  autoCommand(): PendingAction[] {
    return this.awaitingUnits.map((unit) => chooseAutoAllyAction(unit, this.units, this.rng));
  }

  // -------------------------------------------------------------------------
  // 阶段 1：回合开始
  // -------------------------------------------------------------------------

  private async beginTurn(): Promise<void> {
    this.turn += 1;
    this.blocked = new Set<string>();
    this.queued = [];
    this.enterPhase('turnStart');
    this.logIt('phase', `—— 第 ${this.turn} 回合 ——`);
    await this.director?.onTurnStart?.(this.turn);

    for (const unit of this.units) {
      if (!isAlive(unit)) continue;

      unit.hasActed = false;
      unit.isDefending = false;

      const mp = gainMp(unit, BALANCE.mpRegenPerTurn);
      const sp = gainSp(unit, BALANCE.spRegenPerTurn);
      this.logIt('resource', `${unit.name} 自然回复 ${mp} MP、${sp} 愤怒`);

      await this.applyStatusTicks(unit, 'turnStart');
    }

    this.enterPhase('commandInput');
  }

  // -------------------------------------------------------------------------
  // 阶段 3：状态结算
  // -------------------------------------------------------------------------

  private runStatusSettlement(): void {
    for (const unit of this.units) {
      if (!isAlive(unit)) continue;

      const blocker = blockingStatus(unit);
      if (blocker) {
        this.blocked.add(unit.id);
        this.logIt('status', `${unit.name} 因「${blocker.def.name}」本回合无法行动`);
      }

      const modifiers = describeModifiers(unit);
      if (modifiers) this.logIt('status', `${unit.name} 属性修正：${modifiers}`);
    }
  }

  // -------------------------------------------------------------------------
  // 阶段 4：执行玩家指令
  // -------------------------------------------------------------------------

  private async runExecuteCommands(): Promise<void> {
    const submitted = new Map(this.pending.map((action) => [action.actorId, action]));
    const queued: PendingAction[] = [];

    for (const unit of this.survivorsOf('ally')) {
      if (!unit.isPlayerControlled || this.blocked.has(unit.id)) continue;

      let action: PendingAction = submitted.get(unit.id) ?? {
        actorId: unit.id,
        commandId: 'defend',
      };
      if (!submitted.has(unit.id)) {
        this.logIt('system', `${unit.name} 没有收到指令，自动转入防御`);
      }

      let def = getCommand(action.commandId);
      if (!def.resolvesImmediately) {
        const usable = checkUsable(unit, def);
        if (!usable.ok) {
          this.logIt(
            'system',
            `${unit.name} 无法使用「${def.label}」（${usable.reason}），降级为普通攻击`,
          );
          action = { actorId: unit.id, commandId: 'attack' };
          def = getCommand('attack');
        }
      }

      if (def.resolvesImmediately) {
        await this.executeImmediate(unit, action, def);
        if (this.fled) return;
      } else {
        queued.push(action);
      }
    }

    this.queued = queued;
  }

  /** 立即结算的指令：防御、逃跑。 */
  private async executeImmediate(
    actor: BattleUnit,
    action: PendingAction,
    def: CommandDef,
  ): Promise<void> {
    await this.director?.beforeAction?.(actor, action, undefined);

    if (def.id === 'defend') {
      actor.isDefending = true;
      const gained = gainSp(actor, BALANCE.defendSpReward);
      this.logIt('action', `${actor.name} 摆出防御姿态（减伤 50%，愤怒 +${gained}）`);
    } else if (def.id === 'flee') {
      const chance = this.fleeChance(actor);
      if (this.rng.chance(chance)) {
        this.fled = true;
        this.logIt('system', `${actor.name} 带着全队脱离了战斗`);
      } else {
        const gained = gainSp(actor, BALANCE.fleeFailSpReward);
        this.logIt('system', `逃跑失败！${actor.name} 只好硬着头皮留下（愤怒 +${gained}）`);
      }
    } else {
      this.logIt('system', `「${def.label}」没有立即效果`);
    }

    await this.director?.afterAction?.(actor);
  }

  private fleeChance(actor: BattleUnit): number {
    const foes = enemiesOf(this.units, actor);
    if (foes.length === 0) return 1;

    const avgFoeSpd =
      foes.reduce((sum, foe) => sum + effectiveStat(foe, 'spd'), 0) / foes.length;
    const diff = effectiveStat(actor, 'spd') - avgFoeSpd;
    return clamp(BALANCE.fleeBaseChance + diff * BALANCE.fleeSpdFactor, 0.05, 0.95);
  }

  // -------------------------------------------------------------------------
  // 阶段 5：敌我双方行动
  // -------------------------------------------------------------------------

  private async runBothSidesAction(): Promise<void> {
    const actors = this.units
      .filter((unit) => isAlive(unit) && !this.blocked.has(unit.id))
      .sort(
        (a, b) =>
          effectiveStat(b, 'spd') - effectiveStat(a, 'spd') || (a.id < b.id ? -1 : 1),
      );

    for (const actor of actors) {
      if (!isAlive(actor)) {
        this.logIt('system', `${actor.name} 在行动前已经倒下`);
        continue;
      }

      actor.hasActed = true;

      const queued = actor.isPlayerControlled
        ? this.queued.find((action) => action.actorId === actor.id)
        : undefined;

      await this.executeAction(actor, queued ?? chooseEnemyAction(actor, this.units, this.rng));

      if (this.finishIfOver()) return;
    }
  }

  private async executeAction(actor: BattleUnit, action: PendingAction): Promise<void> {
    const def = getCommand(action.commandId);

    // 兜底：资源在中途被 DoT 之类消耗掉的可能性很低，但落空也要有说法。
    if (!payCost(actor, def)) {
      this.logIt('resource', `${actor.name} 资源不足，「${def.label}」未能施展`);
      return;
    }

    const foes = enemiesOf(this.units, actor);
    const target = this.resolveTarget(actor, def, action, foes);

    await this.director?.beforeAction?.(actor, action, target);

    switch (def.id) {
      case 'attack': {
        if (target) {
          await this.strike(actor, target, {
            kind: 'physical',
            mult: 1,
            canCrit: true,
            label: '普通攻击',
          });
        }
        break;
      }

      case 'spell': {
        if (target) {
          this.logIt('action', `${actor.name} 吟唱「炎爆术」，轰向 ${target.name}`);
          await this.strike(actor, target, { kind: 'magical', mult: 1.8, label: '炎爆术' });
          if (isAlive(target) && !hasStatus(target, 'burn') && this.rng.chance(0.35)) {
            await this.inflict(target, getStatusDef('burn'), actor);
          }
        }
        break;
      }

      case 'skill': {
        if (target) {
          this.logIt('action', `${actor.name} 释放特技「碎星斩」，直取 ${target.name}`);
          await this.strike(actor, target, {
            kind: 'physical',
            mult: 2.4,
            canCrit: true,
            label: '碎星斩',
          });
          if (isAlive(target)) await this.inflict(target, getStatusDef('defDown'), actor);
        }
        break;
      }

      case 'talisman': {
        if (target) {
          this.logIt('action', `【占位】${actor.name} 祭出法宝，轰向 ${target.name}`);
          await this.strike(actor, target, {
            kind: 'physical',
            mult: 1.6,
            canCrit: true,
            label: '法宝',
          });
        }
        break;
      }

      case 'spiritTreasure': {
        this.logIt('action', `【占位】${actor.name} 祭出灵宝，灵光普照敌方全体`);
        for (const foe of foes) {
          await this.strike(actor, foe, { kind: 'magical', mult: 1.2, label: '灵宝' });
        }
        break;
      }

      case 'summon': {
        this.logIt('action', `【占位】${actor.name} 召唤灵兽助战`);
        for (const foe of foes) {
          await this.strike(actor, foe, { kind: 'magical', mult: 1.1, label: '召唤' });
        }
        break;
      }

      case 'capture': {
        if (target) await this.attemptCapture(actor, target);
        break;
      }

      // 这两条在「执行玩家指令阶段」就结算完了，不会走到这里。
      case 'defend':
      case 'flee':
        break;
    }

    await this.director?.afterAction?.(actor);
  }

  private async strike(
    attacker: BattleUnit,
    target: BattleUnit,
    spec: DamageSpec,
  ): Promise<void> {
    if (!isAlive(target)) return;

    const outcome = resolveAttack(attacker, target, spec, this.rng);
    const critPrefix = outcome.crit ? '暴击！' : '';
    const hp = Math.max(0, target.stats.hp);
    this.logIt(
      'damage',
      `${critPrefix}「${spec.label}」命中 ${target.name}，造成 ${outcome.dealt} 点伤害（${hp}/${target.stats.maxHp}）`,
    );

    if (outcome.defeated) {
      this.logIt('system', `${target.name} 倒下了`);
    }

    await this.director?.onStrike?.({
      attacker,
      target,
      damage: outcome.dealt,
      healing: 0,
      crit: outcome.crit,
      defeated: outcome.defeated,
      label: spec.label,
    });
  }

  private async inflict(target: BattleUnit, def: StatusDef, source: BattleUnit): Promise<void> {
    const refreshed = applyStatus(target, def, source.id);
    const verb = refreshed ? '刷新了' : def.kind === 'buff' ? '获得了' : '陷入了';
    this.logIt('status', `${target.name} ${verb}「${def.name}」—— ${def.desc}`);

    await this.director?.onStatus?.({
      unit: target,
      name: def.name,
      kind: def.kind,
    });
  }

  /** 占位实现：按目标剩余血量判定成功率。 */
  private async attemptCapture(actor: BattleUnit, target: BattleUnit): Promise<void> {
    const hpRatio = target.stats.hp / target.stats.maxHp;
    const chance = clamp(
      BALANCE.captureBaseChance + (1 - hpRatio) * BALANCE.captureHpWeight,
      0.02,
      0.95,
    );
    this.logIt(
      'action',
      `【占位】${actor.name} 试图捕捉 ${target.name}（成功率约 ${Math.round(chance * 100)}%）`,
    );

    if (this.rng.chance(chance)) {
      target.captured = true;
      this.logIt('system', `捕捉成功！${target.name} 被收服，退出了战斗`);
      await this.director?.onStatus?.({ unit: target, name: '被捕获', kind: 'debuff' });
      await this.director?.onStrike?.({
        attacker: actor,
        target,
        damage: 0,
        healing: 0,
        crit: false,
        defeated: true,
        label: '捕捉',
      });
    } else {
      this.logIt('system', `捕捉失败，${target.name} 挣脱了`);
      await this.director?.onStatus?.({ unit: target, name: '挣脱', kind: 'buff' });
    }
  }

  private resolveTarget(
    actor: BattleUnit,
    def: CommandDef,
    action: PendingAction,
    foes: readonly BattleUnit[],
  ): BattleUnit | undefined {
    if (def.selfOnly) return actor;
    if (!def.requiresTarget || foes.length === 0) return undefined;

    const requested = action.targetId
      ? foes.find((foe) => foe.id === action.targetId)
      : undefined;
    if (requested) return requested;

    const fallback = foes.reduce((weakest, foe) =>
      foe.stats.hp < weakest.stats.hp ? foe : weakest,
    );
    if (action.targetId) {
      this.logIt('system', `${actor.name} 原定目标已不可攻击，转向 ${fallback.name}`);
    }
    return fallback;
  }

  // -------------------------------------------------------------------------
  // 阶段 6：行动结束判定
  // -------------------------------------------------------------------------

  private async runActionEnd(): Promise<void> {
    for (const unit of this.units) {
      if (!isAlive(unit)) continue;
      await this.applyStatusTicks(unit, 'actionEnd');
    }

    for (const unit of this.units) {
      if (!isAlive(unit)) continue;

      for (const status of decrementDurations(unit)) {
        this.logIt('status', `${unit.name} 的「${status.def.name}」结束了`);
      }
      unit.isDefending = false;
    }
  }

  /** 结算某阶段的持续伤害/回复。 */
  private async applyStatusTicks(unit: BattleUnit, trigger: StatusTrigger): Promise<void> {
    for (const tick of collectStatusTicks(unit, trigger)) {
      if (!isAlive(unit)) break;

      if (tick.effect === 'damage') {
        const outcome = applyDamage(unit, tick.amount);
        this.logIt('damage', `${unit.name} 受到「${tick.label}」${outcome.dealt} 点伤害`);
        if (outcome.defeated) this.logIt('system', `${unit.name} 倒下了`);

        await this.director?.onStrike?.({
          attacker: undefined,
          target: unit,
          damage: outcome.dealt,
          healing: 0,
          crit: false,
          defeated: outcome.defeated,
          label: tick.label,
        });
      } else {
        const healed = healHp(unit, tick.amount);
        this.logIt('heal', `${unit.name} 因「${tick.label}」回复 ${healed} 点生命`);

        await this.director?.onStrike?.({
          attacker: undefined,
          target: unit,
          damage: 0,
          healing: healed,
          crit: false,
          defeated: false,
          label: tick.label,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  private finishIfOver(): boolean {
    if (this.result !== null) return true;

    if (this.fled) return this.finish('fled');
    if (!this.units.some((unit) => unit.side === 'enemy' && isAlive(unit))) {
      return this.finish('victory');
    }
    if (!this.units.some((unit) => unit.side === 'ally' && isAlive(unit))) {
      return this.finish('defeat');
    }
    return false;
  }

  private finish(outcome: BattleOutcome): boolean {
    this.result = { outcome, turns: this.turn };
    this.enterPhase(outcome);

    const text =
      outcome === 'victory'
        ? '战斗胜利！'
        : outcome === 'defeat'
          ? '全员倒下……战斗失败。'
          : '成功脱离了战斗。';
    this.logIt('system', text);

    this.events.emit('finished', this.result);
    this.events.emit('update', undefined);
    return true;
  }

  private survivorsOf(side: Side): BattleUnit[] {
    return this.units.filter((unit) => unit.side === side && isAlive(unit));
  }

  private enterPhase(phase: BattlePhase): void {
    this.phase = phase;
    this.events.emit('phase', phase);
  }

  private logIt(kind: LogKind, text: string): void {
    const entry: BattleLogEntry = { turn: this.turn, kind, text };
    this.log.push(entry);
    this.events.emit('log', entry);
  }
}

/** 列出与基础值不同的属性，用于日志与调试。 */
function describeModifiers(unit: BattleUnit): string {
  const parts: string[] = [];
  for (const key of STAT_KEYS) {
    const base = unit.stats[key];
    if (base === 0) continue;
    const effective = effectiveStat(unit, key);
    if (effective === base) continue;
    const percent = Math.round((effective / base - 1) * 100);
    parts.push(`${key}${percent >= 0 ? '+' : ''}${percent}%`);
  }
  return parts.join('，');
}

function hasStatus(unit: BattleUnit, id: string): boolean {
  return unit.statuses.some((status) => status.def.id === id);
}

/** 先校验再扣除，避免扣了 MP 却发现 SP 不够的半途状态。 */
function payCost(unit: BattleUnit, def: CommandDef): boolean {
  const mp = def.cost.mp ?? 0;
  const sp = def.cost.sp ?? 0;
  if (unit.stats.mp < mp || unit.stats.sp < sp) return false;
  if (mp > 0) spendMp(unit, mp);
  if (sp > 0) spendSp(unit, sp);
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
