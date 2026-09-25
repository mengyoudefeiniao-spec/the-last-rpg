/**
 * 战斗领域类型 —— 全项目数据类型的唯一来源（见 src/README.md）。
 * 约定：本文件只放类型，不放逻辑。
 */

/** 阵营：我方 / 敌方。 */
export type Side = 'ally' | 'enemy';

/**
 * 可被状态效果修正的属性。
 * 注意不含 maxHp/maxMp/maxSp —— 改上限要同步当前值，原型阶段不做这件事。
 */
export type StatKey = 'atk' | 'def' | 'mag' | 'res' | 'spd';

/** 属性面板：HP / MP / SP 同时含上限与当前值。 */
export interface Stats {
  maxHp: number;
  hp: number;
  maxMp: number;
  mp: number;
  /** SP（Skill Points）= 愤怒，用于释放特技。 */
  maxSp: number;
  sp: number;
  /** 物理攻击。 */
  atk: number;
  /** 物理防御。 */
  def: number;
  /** 法术强度。 */
  mag: number;
  /** 法术抗性。 */
  res: number;
  /** 速度，决定「敌我双方行动阶段」的行动顺序。 */
  spd: number;
}

/** 状态效果的结算时机，与状态机的阶段一一对应。 */
export type StatusTrigger = 'turnStart' | 'actionEnd';

/** 持续伤害/回复的取值方式。 */
export type StatusPowerMode = 'flat' | 'percentMaxHp';

/** 状态效果定义（模板）。 */
export interface StatusDef {
  id: string;
  name: string;
  kind: 'buff' | 'debuff';
  /** 初始持续回合数。 */
  duration: number;
  /** 属性倍率修正：{ atk: 0.3 } 表示攻击力 +30%。 */
  modifiers?: Partial<Record<StatKey, number>>;
  /** 持续伤害。 */
  dot?: { label: string; power: number; mode: StatusPowerMode };
  /** 持续回复。 */
  hot?: { label: string; power: number; mode: StatusPowerMode };
  /** 眩晕：本回合无法行动。 */
  skipAction?: boolean;
  /** 受击时额外获得的 SP 倍率加成，用于「挨打越痛愤怒涨得越快」的单位。 */
  spGainBonus?: number;
  /** 在哪个阶段结算。 */
  trigger: StatusTrigger;
  /** 给玩家看的说明。 */
  desc: string;
}

/** 挂在单位身上的状态实例。 */
export interface ActiveStatus {
  uid: string;
  def: StatusDef;
  /** 剩余回合数，在「行动结束判定阶段」递减。 */
  remaining: number;
  sourceId: string;
}

/** 伤害类型：物理吃 def，魔法吃 res。 */
export type DamageKind = 'physical' | 'magical';

/** 创建战斗单位的输入。 */
export interface BattleUnitInit {
  id: string;
  name: string;
  side: Side;
  /** 默认：我方 true、敌方 false。 */
  isPlayerControlled?: boolean;
  /** 只需给出上限，未提供的当前值默认回满。 */
  stats: Partial<Stats> & Pick<Stats, 'maxHp' | 'maxMp' | 'maxSp'>;
  /** 开场自带的状态。 */
  statuses?: StatusDef[];
}

/** 战斗单位，我方与敌方共用同一结构。 */
export interface BattleUnit {
  id: string;
  name: string;
  side: Side;
  stats: Stats;
  statuses: ActiveStatus[];
  /** 本回合是否处于防御姿态，行动结束后解除。 */
  isDefending: boolean;
  /** 本回合是否已行动过。 */
  hasActed: boolean;
  /** 是否已被捕捉（原型：直接移出战斗）。 */
  captured: boolean;
  /** 原型阶段敌人是简单 AI，我方由玩家下达指令。 */
  isPlayerControlled: boolean;
}

/** 九种战斗指令。 */
export type CommandId =
  | 'attack'
  | 'spell'
  | 'skill'
  | 'talisman'
  | 'spiritTreasure'
  | 'summon'
  | 'capture'
  | 'defend'
  | 'flee';

/** 指令定义。 */
export interface CommandDef {
  id: CommandId;
  label: string;
  desc: string;
  /** 是否需要选择目标。 */
  requiresTarget: boolean;
  /** 只能对自己使用。 */
  selfOnly?: boolean;
  /** 消耗。 */
  cost: { mp?: number; sp?: number };
  /**
   * true  = 在「执行玩家指令阶段」立即结算（防御、逃跑）；
   * false = 固化进行动队列，在「敌我双方行动阶段」按速度结算。
   */
  resolvesImmediately: boolean;
  /** 原型阶段的占位实现（法宝 / 灵宝 / 召唤 / 捕捉）。 */
  placeholder?: boolean;
}

/** 玩家下达的一条指令。 */
export interface PendingAction {
  actorId: string;
  commandId: CommandId;
  targetId?: string;
}

/**
 * 战斗状态机的阶段。
 * 顺序：turnStart → commandInput → statusSettlement → executeCommands
 *      → bothSidesAction → actionEnd → 下一回合。
 */
export type BattlePhase =
  | 'turnStart'
  | 'commandInput'
  | 'statusSettlement'
  | 'executeCommands'
  | 'bothSidesAction'
  | 'actionEnd'
  | 'victory'
  | 'defeat'
  | 'fled';

/** 日志条目的分类，UI 据此上色。 */
export type LogKind = 'system' | 'phase' | 'action' | 'damage' | 'heal' | 'status' | 'resource';

export interface BattleLogEntry {
  turn: number;
  kind: LogKind;
  text: string;
}

/** 战斗结局。 */
export type BattleOutcome = 'victory' | 'defeat' | 'fled';

export interface BattleResult {
  outcome: BattleOutcome;
  /** 打完这场战斗用掉的回合数。 */
  turns: number;
}

/** 战斗对外广播的事件，UI 与测试各自订阅。 */
export interface BattleEvents extends Record<string, unknown> {
  log: BattleLogEntry;
  phase: BattlePhase;
  /** 任何影响界面显示的状态变化。 */
  update: undefined;
  finished: BattleResult;
}
