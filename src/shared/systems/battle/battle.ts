import { BALANCE } from '../../config/balance.ts';
import { EventBus } from '../../core/event-bus.ts';
import { createRng, type Rng } from '../../core/rng.ts';
import type {
  ActiveStatus,
  BattleEvents,
  Battlefield,
  BattleLogEntry,
  BattleOutcome,
  BattlePhase,
  BattleResult,
  BattleUnit,
  CommandDef,
  Formation,
  ItemDef,
  ItemStack,
  LogKind,
  PendingAction,
  Side,
  StageEventDef,
  StatusDef,
  StatusTrigger,
} from '../../data/types.ts';
import { getStatusDef, type StatusId } from '../../data/statuses.ts';
import { getItemDef, STARTING_ITEMS } from '../../data/items.ts';
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
import { getCommand } from './commands.ts';
import {
  applyStatus,
  blockingStatus,
  collectStatusTicks,
  decrementDurations,
  effectiveStat,
  removeStatus,
} from './status-effects.ts';
import { desiredTerrainEffects, isTerrainStatus, terrainSourceId } from './terrain.ts';

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
  /** 新的一轮开始（全员各行动一次算一轮）。 */
  onRoundStart?(round: number): Promise<void> | void;
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
  /** 剧情级事件降临（天雷、地震、海啸……），演出在战场上方的事件区展开。 */
  onStageEvent?(
    def: StageEventDef,
    targets: BattleUnit[],
    anchor: { x: number; y: number; z: number },
  ): Promise<void> | void;
}

export interface BattleOptions {
  units: BattleUnit[];
  /**
   * 战场定义：敌方阵位与地形分区。
   * 省略时用一份没有地形的空白战场 —— 单元测试与自动战斗走这条路。
   */
  battlefield?: Battlefield;
  /**
   * 我方阵法。它决定我方站在哪，进而决定吃到什么地形 —— 这是阵法的全部规则作用。
   * 省略时用空白阵法（阵位为空，站位保持 createUnit 给的默认值）。
   */
  formation?: Formation;
  /** 固定 seed 即可重放同一场战斗，便于复现 bug。 */
  seed?: number;
  /** 开局的队伍道具。省略时用 STARTING_ITEMS（原型阶段的默认配置）。 */
  items?: ReadonlyArray<ItemStack>;
}

/** 没有任何地形效果的空白战场。 */
function emptyBattlefield(): Battlefield {
  return {
    id: 'empty',
    name: '无名之地',
    desc: '此地并无特异之处。',
    enemySlots: [],
    zones: [],
    eventArea: {
      center: { x: 0, y: 26, z: 0 },
      radius: 16,
      height: 14,
      note: '测试用的空白战场，事件区不参与任何逻辑',
    },
  };
}

/** 没有阵位的空白阵法 —— 站位保持 createUnit 给的默认值。 */
function emptyFormation(): Formation {
  return {
    id: 'none',
    name: '无阵',
    desc: '散兵游勇，不成阵势。',
    slots: [],
    links: [],
    color: 0x8899aa,
  };
}

/**
 * 行动条驱动的战斗（实时 ATB）。
 *
 * 没有「回合」——战斗是一段连续推进：
 *
 *   1. 每个单位的行动值按 速度 × gaugeRate 每秒往上走（见 advance）
 *   2. 涨满 100 的单位才能行动：
 *      · 我方 → 挂上 awaitingCommand，**等玩家下指令**（整个战场的时间就此停住）
 *      · 敌方 → 立即由 AI 行动
 *   3. 行动完条归零，从头再攒
 *
 * 「时间」由外部注入：服务端按节拍调 advance(dt)，测试直接喂一大段 —— 所以逻辑里
 * 没有任何定时器，也不需要真实时钟，整场战斗可以在几毫秒内跑完。
 *
 * 全员各行动一次算「一轮」，状态的持续回合与 DoT/HoT 以轮为界结算。
 */
export class Battle {
  readonly units: BattleUnit[];
  readonly events = new EventBus<BattleEvents>();
  readonly log: BattleLogEntry[] = [];

  /** 战场：敌方阵位与地形分区。 */
  readonly battlefield: Battlefield;

  /** 我方阵法。站位在构造时就按它定死了，战斗中不变。 */
  readonly formation: Formation;

  /** 表现层。可以在构造之后再挂上。 */
  director: BattleDirector | undefined;

  phase: BattlePhase = 'deployment';
  /** 轮次。全员各行动一次算一轮（不是固定时间）。 */
  round = 0;
  result: BattleResult | null = null;

  /**
   * 队伍共用的道具池。
   *
   * 全队一个池子，而不是每人一个背包 —— 界面上的「道具」列表是**队伍的**，
   * 不是某个人身上的。用掉一个就少一个。
   */
  readonly partyItems: ItemStack[];

  private readonly rng: Rng;
  private fled = false;
  /** 防重入：advance 与 submitAction 都是异步的，不能交错执行。 */
  private busy = false;

  constructor(options: BattleOptions) {
    this.units = options.units;
    this.battlefield = options.battlefield ?? emptyBattlefield();
    this.formation = options.formation ?? emptyFormation();
    this.rng = createRng(options.seed ?? 0x5eed);
    this.partyItems = (options.items ?? STARTING_ITEMS).map((stack) => ({ ...stack }));
    this.assignInitialPositions();
  }

  /**
   * 按阵位分派初始站位。
   *
   * 我方用**阵法**的阵位 —— 这是阵法的全部规则作用：它决定你站哪，
   * 进而决定你吃到哪个地形。敌方不设阵法，用战场自带的 enemySlots。
   */
  private assignInitialPositions(): void {
    const place = (
      units: BattleUnit[],
      slots: ReadonlyArray<{ x: number; z: number }>,
    ): void => {
      units.forEach((unit, index) => {
        const slot = slots[index];
        if (slot) unit.position = { x: slot.x, z: slot.z };
      });
    };

    place(
      this.units.filter((unit) => unit.side === 'ally'),
      this.formation.slots,
    );
    place(
      this.units.filter((unit) => unit.side === 'enemy'),
      this.battlefield.enemySlots,
    );
  }

  /** 某个我方单位站的是哪个阵位（没有则 undefined）。 */
  formationSlotOf(unitId: string): Formation['slots'][number] | undefined {
    const index = this.units.filter((unit) => unit.side === 'ally').findIndex((u) => u.id === unitId);
    return index >= 0 ? this.formation.slots[index] : undefined;
  }

  get finished(): boolean {
    return this.result !== null;
  }

  /** 行动值已满、正等着玩家下指令的我方单位。只有这些才该显示指令栏。 */
  get awaitingUnits(): BattleUnit[] {
    if (this.finished) return [];
    return this.survivorsOf('ally').filter((unit) => unit.awaitingCommand);
  }

  /** 进入布阵阶段：预览阵法与地形，确认后开战。站位由阵法定死，此处不能改。 */
  start(): void {
    if (this.round !== 0) throw new Error('战斗已经开始，请新建实例');
    this.enterPhase('deployment');

    this.logIt('system', `来到「${this.battlefield.name}」—— ${this.battlefield.desc}`);
    this.logIt('system', `我方形「${this.formation.name}」—— ${this.formation.desc}`);

    for (const zone of this.battlefield.zones) {
      this.logIt('status', `地形「${zone.name}」：${zone.desc}`);
    }

    for (const unit of this.units) {
      if (unit.side === 'ally') this.reportPosition(unit);
    }

    this.events.emit('update', undefined);
  }

  /** 布阵完成，开打。此后战斗由 advance() 推进。 */
  async beginBattle(): Promise<void> {
    if (this.phase !== 'deployment') throw new Error('当前不在布阵阶段');
    this.logIt('system', '阵势已定，战斗开始！');
    this.enterPhase('battle');

    await this.beginRound();
    this.events.emit('update', undefined);
  }

  // ==========================================================================
  // 行动条
  // ==========================================================================

  /**
   * 推进行动条。
   *
   * **时间由外部注入**：服务端按节拍调用，测试直接喂一大段 deltaMs。
   * 一大段会被切成 gaugeStep 的小步，免得一步就跨过「谁先到行动点」的细节。
   *
   * 我方有单位在等指令时，**整个战场的时间停住** —— 敌我的行动值都不再涨，直到指令下完。
   * 这是刻意的：不该出现「你还在斟酌，敌人却偷跑一轮」。
   * 停的是**行动值**；演出的动画该播还是照播，那是两回事。
   */
  async advance(deltaMs: number): Promise<void> {
    if (this.phase !== 'battle' || this.finished || this.busy) return;

    this.busy = true;
    try {
      let remaining = deltaMs / 1000;

      while (remaining > 0 && this.phase === 'battle' && !this.finished) {
        // 有人在等我方指令 —— 整个战场的时间停住，等他决定
        if (this.awaitingUnits.length > 0) break;

        const step = Math.min(remaining, BALANCE.gaugeStep);
        remaining -= step;

        for (const unit of this.units) {
          if (!isAlive(unit) || unit.awaitingCommand) continue;

          unit.actionGauge = Math.min(
            BALANCE.gaugeMax,
            unit.actionGauge + effectiveStat(unit, 'spd') * BALANCE.gaugeRate * step,
          );
        }

        await this.processReadyUnits();
      }

      this.events.emit('update', undefined);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 处理所有条已满的单位。
   *
   * 我方条满 → 挂上 awaitingCommand 后**立刻收手**：这一拍就到此为止，整个战场停下等指令，
   * 排在后面的敌方单位也不许出手。
   * 敌方条满 → 立刻由 AI 行动（前提是没有我方单位正在等指令）。
   */
  private async processReadyUnits(): Promise<void> {
    for (const unit of this.units) {
      if (this.finished) return;
      if (!isAlive(unit)) continue;
      if (unit.actionGauge < BALANCE.gaugeMax) continue;

      // 到点了 —— 上一次摆的防御姿态到这里结束。
      // 「防御撑到下次行动点」说的就是这一刻：在此之前敌人打你都是减半的。
      unit.isDefending = false;

      if (unit.isPlayerControlled) {
        if (unit.awaitingCommand) continue;

        unit.awaitingCommand = true;
        this.logIt('phase', `${unit.name} 的行动条已满 —— 等待你的指令`);
        return;
      }

      await this.takeTurn(unit, chooseEnemyAction(unit, this.units, this.rng));
      if (this.finishIfOver()) return;
    }
  }

  /** 玩家为某个条已满的单位下达指令。 */
  async submitAction(unitId: string, action: PendingAction): Promise<void> {
    if (this.phase !== 'battle') throw new Error(`当前阶段是 ${this.phase}，不接受指令`);
    if (this.busy) throw new Error('战斗正在处理中，请稍候');

    const unit = this.units.find((candidate) => candidate.id === unitId);
    if (!unit) throw new Error('找不到这个单位');
    if (!isAlive(unit)) throw new Error(`${unit.name} 已经不行动了`);
    if (!unit.awaitingCommand) throw new Error(`${unit.name} 的行动条还没满`);

    this.busy = true;
    try {
      await this.takeTurn(unit, action);
      if (this.finishIfOver()) return;

      // 刚才那一小段时间里，别的单位可能也到点了
      await this.processReadyUnits();
      this.events.emit('update', undefined);
    } finally {
      this.busy = false;
    }
  }

  /** 一个单位的一次完整行动：清条 → 前摇 → 结算 → 收尾。 */
  private async takeTurn(actor: BattleUnit, action: PendingAction): Promise<void> {
    actor.awaitingCommand = false;
    actor.actionGauge = 0;
    actor.actedThisRound = true;

    // 被眩晕之类控住：这次行动作废，但条照样清空 —— 控制技能的价值就在这里
    const blocker = blockingStatus(actor);
    if (blocker) {
      this.logIt('status', `${actor.name} 因「${blocker.def.name}」无法行动`);
      await this.endTurn(actor);
      return;
    }

    await this.executeAction(actor, action);
    await this.endTurn(actor);
  }

  /** 一次行动的收尾：DoT/HoT、状态倒计时、归位，然后看看要不要开新一轮。 */
  private async endTurn(actor: BattleUnit): Promise<void> {
    await this.applyStatusTicks(actor, 'actionEnd');
    if (this.finishIfOver()) return;

    for (const status of decrementDurations(actor)) {
      this.logIt('status', `${actor.name} 的「${status.def.name}」结束了`);
    }

    // 防御姿态**不在这里解** —— 它要一直撑到这个单位下次条满（见 processReadyUnits）
    await this.director?.afterAction?.(actor);

    if (this.finished) return;

    const alive = this.units.filter((unit) => isAlive(unit));
    if (alive.length > 0 && alive.every((unit) => unit.actedThisRound)) {
      await this.beginRound();
    }
  }

  /**
   * 开一轮。
   *
   * 行动条没有固定回合，但状态的持续与 DoT/HoT 总得有个结算粒度 ——
   * 这里取「全员各行动一次」为一轮，也就是最接近直觉的那个。
   */
  private async beginRound(): Promise<void> {
    this.round += 1;
    this.logIt('phase', `—— 第 ${this.round} 轮 ——`);

    for (const unit of this.units) {
      if (isAlive(unit)) unit.actedThisRound = false;
    }

    await this.director?.onRoundStart?.(this.round);

    // 必须早于其他轮开始效果：否则这轮刚站进冻伤区，要等下一轮才生效
    await this.syncTerrainStatuses();

    for (const unit of this.units) {
      if (!isAlive(unit)) continue;

      const mp = gainMp(unit, BALANCE.mpRegenPerRound);
      const sp = gainSp(unit, BALANCE.spRegenPerRound);
      this.logIt('resource', `${unit.name} 自然回复 ${mp} MP、${sp} 愤怒`);

      await this.applyStatusTicks(unit, 'turnStart');
    }
  }

  /** 演示与测试用：让所有条已满的我方单位各自动出一手。 */
  async autoAct(): Promise<void> {
    while (!this.finished && this.awaitingUnits.length > 0) {
      const unit = this.awaitingUnits[0];
      if (!unit) break;
      await this.submitAction(unit.id, chooseAutoAllyAction(unit, this.units, this.rng));
    }
  }

  // ==========================================================================
  // 剧情事件
  // ==========================================================================

  /**
   * 剧情事件降临。
   *
   * 事件不属于任何单位 —— 它从战场上方的事件区（StageEventArea）压下来，
   * 对全场存活单位结算一次。海啸、地震、渡劫天雷都走这条路径。
   * 目前只有一个演示用的天雷，将来由剧情系统触发。
   */
  async triggerStageEvent(def: StageEventDef): Promise<void> {
    if (this.finished) throw new Error('战斗已经结束，不再触发剧情事件');

    const targets = this.units.filter((unit) => isAlive(unit));
    if (targets.length === 0) return;

    this.logIt('phase', def.text);
    await this.director?.onStageEvent?.(def, targets, this.battlefield.eventArea.center);

    for (const target of targets) {
      if (!isAlive(target)) continue;

      if (def.damagePercent <= 0) {
        await this.director?.onStrike?.({
          attacker: undefined,
          target,
          damage: 0,
          healing: 0,
          crit: false,
          defeated: false,
          label: def.name,
        });
        continue;
      }

      const damage = Math.round(target.stats.maxHp * def.damagePercent);
      const outcome = applyDamage(target, damage);

      this.logIt('damage', `${target.name} 被「${def.name}」击中，受到 ${outcome.dealt} 点伤害`);
      if (outcome.defeated) this.logIt('system', `${target.name} 倒下了`);

      await this.director?.onStrike?.({
        attacker: undefined,
        target,
        damage: outcome.dealt,
        healing: 0,
        crit: false,
        defeated: outcome.defeated,
        label: def.name,
      });
    }

    this.finishIfOver();
    this.events.emit('update', undefined);
  }

  // ==========================================================================
  // 指令执行
  // ==========================================================================

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

      case 'useItem': {
        if (target) {
          await this.useItem(actor, target, action.itemId);
        } else {
          this.logIt('system', `${actor.name} 的「道具」没有指定到自己人身上，作罢`);
        }
        break;
      }

      case 'defend': {
        actor.isDefending = true;
        const gained = gainSp(actor, BALANCE.defendSpReward);
        this.logIt('action', `${actor.name} 摆出防御姿态（减伤 50%，愤怒 +${gained}）`);
        break;
      }

      case 'flee': {
        const chance = this.fleeChance(actor);
        if (this.rng.chance(chance)) {
          this.fled = true;
          this.logIt('system', `${actor.name} 带着全队脱离了战斗`);
        } else {
          const gained = gainSp(actor, BALANCE.fleeFailSpReward);
          this.logIt('system', `逃跑失败！${actor.name} 只好硬着头皮留下（愤怒 +${gained}）`);
        }
        break;
      }
    }
  }

  /**
   * 用掉一件道具。
   *
   * 道具全是**单体** —— 只能给自己人。所以这里会拦下「对敌人用」的情况：
   * 界面本来就不该给这个选项，但服务端不能指望界面守规矩。
   */
  private async useItem(
    actor: BattleUnit,
    target: BattleUnit,
    itemId: string | undefined,
  ): Promise<void> {
    const def = itemId ? getItemDef(itemId) : undefined;
    const stack = itemId
      ? this.partyItems.find((entry) => entry.itemId === itemId)
      : undefined;

    if (!def || !stack || stack.count <= 0) {
      this.logIt('resource', `${actor.name} 想用道具，但背包里已经没有这一件了`);
      return;
    }

    if (target.side !== actor.side) {
      this.logIt('system', `道具只能对自己人用，「${def.name}」没有出手`);
      return;
    }

    stack.count -= 1;
    if (stack.count <= 0) {
      this.partyItems.splice(this.partyItems.indexOf(stack), 1);
    }

    await this.applyItem(actor, target, def);
  }

  /** 结算一件道具。恢复 / 解除 / 增益三类各走一条路。 */
  private async applyItem(actor: BattleUnit, target: BattleUnit, def: ItemDef): Promise<void> {
    if (def.heal) {
      const { resource, scale } = def.heal;
      const isHp = resource === 'hp';
      const max = isHp ? target.stats.maxHp : target.stats.maxMp;
      const before = isHp ? target.stats.hp : target.stats.mp;

      const amount =
        scale.mode === 'full'
          ? max
          : scale.mode === 'flat'
            ? scale.amount
            : Math.round(max * scale.percent);

      const after = Math.max(0, Math.min(max, Math.round(before + amount)));
      const healed = Math.round(after - before);

      if (isHp) target.stats.hp = after;
      else target.stats.mp = after;

      const label = isHp ? '生命' : '法力';
      this.logIt(
        'heal',
        healed > 0
          ? `${actor.name} 给 ${target.name} 用了「${def.name}」，回复 ${healed} 点${label}（${Math.round(after)}/${max}）`
          : `${actor.name} 给 ${target.name} 用了「${def.name}」，但${label}已是满的`,
      );
      return;
    }

    if (def.cure) {
      const removed = target.statuses.filter((status) => this.curable(def, status));
      target.statuses = target.statuses.filter((status) => !this.curable(def, status));

      this.logIt(
        'status',
        removed.length > 0
          ? `${actor.name} 给 ${target.name} 用了「${def.name}」，解除「${removed.map((s) => s.def.name).join('、')}」`
          : `${actor.name} 给 ${target.name} 用了「${def.name}」，但没有可解的异常`,
      );
      return;
    }

    if (def.buffStatus) {
      const statusDef = getStatusDef(def.buffStatus as StatusId);
      await this.inflict(target, statusDef, actor);
      this.logIt(
        'status',
        `${actor.name} 给 ${target.name} 用了「${def.name}」，获得「${statusDef.name}」`,
      );
      return;
    }

    this.logIt('system', `【占位】「${def.name}」还没有实装效果`);
  }

  /** 这件道具解不解得掉这个状态。只对减益生效 —— 增益本来就不该被「解」。 */
  private curable(def: ItemDef, status: ActiveStatus): boolean {
    if (!def.cure || status.def.kind !== 'debuff') return false;
    return def.cure.mode === 'all' || def.cure.statusIds.includes(status.def.id);
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

    // 道具这类指令的目标在自己这边 —— 从本方存活者里挑
    const pool =
      def.targetSide === 'ally'
        ? this.survivorsOf(actor.side === 'ally' ? 'ally' : 'enemy')
        : foes;

    if (!def.requiresTarget || pool.length === 0) return undefined;

    const requested = action.targetId
      ? pool.find((unit) => unit.id === action.targetId)
      : undefined;
    if (requested) return requested;

    /*
     * 道具**不做兜底**：指错人（比如点了敌人）就该整个作废，
     * 而不是擅自换个人把药灌下去 —— 药是有限的，乱花比不花更糟。
     * 攻击类才需要「原目标死了就换一个」这种宽容。
     */
    if (def.needsItem) return undefined;

    // 没指定（或指定的人已倒下）就兜底：挑血最少的那个
    const fallback = pool.reduce((weakest, unit) =>
      unit.stats.hp < weakest.stats.hp ? unit : weakest,
    );
    if (action.targetId) {
      this.logIt('system', `${actor.name} 原定目标已不可用，转向 ${fallback.name}`);
    }
    return fallback;
  }

  private fleeChance(actor: BattleUnit): number {
    const foes = enemiesOf(this.units, actor);
    if (foes.length === 0) return 1;

    const avgFoeSpd =
      foes.reduce((sum, foe) => sum + effectiveStat(foe, 'spd'), 0) / foes.length;
    const diff = effectiveStat(actor, 'spd') - avgFoeSpd;
    return clamp(BALANCE.fleeBaseChance + diff * BALANCE.fleeSpdFactor, 0.05, 0.95);
  }

  // ==========================================================================
  // 状态与地形
  // ==========================================================================

  /**
   * 地形同步：站在哪个区域就获得该区域的状态，走出去就移除。
   *
   * 这是「站位决定增益/减益」的唯一落点。想加一个新地形，
   * 只改 data/battlefields.ts，这里一行都不用动。
   */
  private async syncTerrainStatuses(): Promise<void> {
    for (const unit of this.units) {
      if (!isAlive(unit)) continue;

      const { zone, statusIds } = desiredTerrainEffects(this.battlefield, unit.position);
      const desired = new Set(statusIds);

      // 1) 先清掉「已离开的区域」留下的状态
      for (const status of [...unit.statuses]) {
        if (!isTerrainStatus(status)) continue;
        if (desired.has(status.def.id)) continue;

        removeStatus(unit, status.def.id);
        this.logIt('status', `${unit.name} 脱离地形影响，「${status.def.name}」消退`);
      }

      // 2) 再施加（或刷新）当前区域的状态
      if (!zone) continue;

      for (const effect of zone.effects) {
        const already = unit.statuses.some((status) => status.def.id === effect.id);
        applyStatus(unit, effect, terrainSourceId(zone.id));
        if (already) continue;

        this.logIt('status', `${unit.name} 受「${zone.name}」影响，获得「${effect.name}」`);
        await this.director?.onStatus?.({ unit, name: effect.name, kind: effect.kind });
      }
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

  // ==========================================================================
  // 收尾
  // ==========================================================================

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
    this.result = { outcome, turns: this.round };
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
    const entry: BattleLogEntry = { round: this.round, kind, text };
    this.log.push(entry);
    this.events.emit('log', entry);
  }

  /** 把某个我方单位的落点与阵位写进日志 —— 玩家据此看清这个阵法的代价。 */
  private reportPosition(unit: BattleUnit): void {
    const { zone } = desiredTerrainEffects(this.battlefield, unit.position);
    const slot = this.formationSlotOf(unit.id);
    const who = slot ? `${unit.name}（${slot.role}）` : unit.name;

    this.logIt(
      'status',
      zone ? `${who} 立于「${zone.name}」 —— ${zone.desc}` : `${who} 处于普通地面`,
    );
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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
