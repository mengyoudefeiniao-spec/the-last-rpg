/**
 * 战斗领域类型 —— 全项目数据类型的唯一来源（见 src/README.md）。
 * 约定：本文件只放类型，不放逻辑。
 */

/** 阵营：我方 / 敌方。 */
export type Side = 'ally' | 'enemy';

/**
 * 战场地面坐标。x 向右、z 朝镜头（近处）——
 * 与 three.js 场景坐标一致，渲染层可以直接拿去用，不需要再换算。
 */
export interface BattlePosition {
  x: number;
  z: number;
}

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
  /** 初始持续回合数。由地形施加的状态会每回合被刷新，不靠倒计时结束。 */
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
  /** 来源标识。地形施加的状态以 `terrain:` 开头，离开区域时据此移除。 */
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
  /** 初始站位。服务端开战时按阵位分派，这里给的会被覆盖。 */
  position?: BattlePosition;
}

/** 战斗单位，我方与敌方共用同一结构。 */
export interface BattleUnit {
  id: string;
  name: string;
  side: Side;
  stats: Stats;
  statuses: ActiveStatus[];
  /** 战场站位。地形效果按它判定（见 systems/battle/terrain.ts）。 */
  position: BattlePosition;
  /** 本回合是否处于防御姿态，行动结束后解除。 */
  isDefending: boolean;
  /** 本回合是否已行动过。 */
  hasActed: boolean;
  /** 是否已被捕捉（原型：直接移出战斗）。 */
  captured: boolean;
  /** 原型阶段敌人是简单 AI，我方由玩家下达指令。 */
  isPlayerControlled: boolean;
}

// ---------------------------------------------------------------------------
// 阵法 —— 只作用于我方
// ---------------------------------------------------------------------------

/** 阵位：一个落点，以及它在这个阵法里的角色名。 */
export interface FormationSlot {
  x: number;
  z: number;
  /** 阵位名，如「锋头」「中军」「左翼尖」。 */
  role: string;
}

/** 阵图上的一条连线，按阵位索引连接两点。纯表现，不参与规则。 */
export interface FormationLink {
  from: number;
  to: number;
}

/**
 * 阵法。
 *
 * **只作用于我方** —— 敌方不设阵法，用的是战场自带的 enemySlots。
 * 阵法是**战斗外**的配置（队伍配置的一部分），开战时才被读取来分派站位，
 * 战斗中不能更换，也不能在布阵阶段把阵位换掉。
 *
 * 目前的阵法只决定「站哪」，还没有数值加成；将来若要加，在这里补一个 effects 字段即可。
 */
export interface Formation {
  id: string;
  name: string;
  desc: string;
  /** 阵位，按顺序对应我方第 1..N 号位。 */
  slots: FormationSlot[];
  /** 阵图连线，渲染层据此画出阵图。 */
  links: FormationLink[];
  /** 阵图配色。 */
  color: number;
}

// ---------------------------------------------------------------------------
// 场景外观 —— 不影响战斗规则，只影响观感
// ---------------------------------------------------------------------------

/** 环境主题：天空、雾气、光照、地面。 */
export interface EnvironmentTheme {
  id: string;
  name: string;
  desc: string;
  /** 背景 / 远景色。 */
  sky: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  /** 地面主色。 */
  ground: number;
  gridMajor: number;
  gridMinor: number;
  keyLight: number;
  keyIntensity: number;
  hemiSky: number;
  hemiGround: number;
  /** 主光方向，决定影子的斜度。 */
  keyDirection: [number, number, number];
}

/** 天气的种类，决定粒子怎么动。 */
export type WeatherKind = 'clear' | 'snow' | 'rain' | 'sand' | 'mist';

/** 天气预设：叠在环境之上的粒子效果。 */
export interface WeatherPreset {
  id: string;
  name: string;
  desc: string;
  kind: WeatherKind;
  /** 粒子数量，0 表示不放粒子。 */
  density: number;
  color: number;
  /** 下落速度（单位/秒），负值表示上浮。 */
  fallSpeed: number;
  /** 横向风速，决定粒子的斜度。 */
  drift: number;
  /** 粒子大小。 */
  size: number;
}

/**
 * 战场上方的事件区 —— **目前完全不渲染**。
 *
 * 预留给剧情事件：海啸（自远处涌来）、地震（地面震裂）、渡劫天雷（自天而降）之类。
 * 现在只提供一个位置锚点与触发接口，等剧情系统来了直接往上接。
 */
export interface StageEventArea {
  /** 区域中心，位于战场正上方。 */
  center: { x: number; y: number; z: number };
  /** 水平半径。 */
  radius: number;
  /** 垂直厚度。 */
  height: number;
  /** 这块区域预留给什么，给后来的人看。 */
  note: string;
}

// ---------------------------------------------------------------------------
// 地形与战场
// ---------------------------------------------------------------------------

/** 地形分区的视觉/语义类别，渲染层据此上色。 */
export type TerrainKind = 'snow' | 'flame' | 'spring' | 'miasma';

/**
 * 战场上的地形分区。
 *
 * 圆形区域：单位站在圈内就被施加 effects 里的状态，走出去自动移除。
 * 这是「站位决定吃到什么增益/减益」的全部实现基础 —— 没有别的地方硬编码地形效果。
 */
export interface TerrainZone {
  id: string;
  name: string;
  kind: TerrainKind;
  center: BattlePosition;
  radius: number;
  /** 站在圈内时获得的状态；离开区域由 terrain 同步逻辑移除。 */
  effects: StatusDef[];
  desc: string;
}

/**
 * 一份战场定义：敌方阵位 + 地形分区 + 上方事件区。
 *
 * 注意这里**没有我方阵位** —— 我方的站位由阵法（Formation）决定，
 * 所以换一个阵法，同一张战场上的地形取舍就完全不同。
 */
export interface Battlefield {
  id: string;
  name: string;
  desc: string;
  /** 敌方阵型槽位。敌方不设阵法，用战场自带的这一套。 */
  enemySlots: BattlePosition[];
  zones: TerrainZone[];
  /** 上方的事件区（预留，不渲染）。 */
  eventArea: StageEventArea;
}

// ---------------------------------------------------------------------------
// 战斗外配置
// ---------------------------------------------------------------------------

/**
 * 战斗外配好的「队伍出战设置」。
 *
 * 存在服务端（见 src/server/party-config.ts），开战时读取。
 * 将来它会由菜单里的设置页写入 —— 现在先用顶栏的临时入口代替。
 */
export interface PartyConfig {
  /** 我方阵法。 */
  formationId: string;
  /** 战场（决定地形）。 */
  battlefieldId: string;
  /** 场景外观 —— 下面两项只管观感。 */
  environmentId: string;
  weatherId: string;
}

// ---------------------------------------------------------------------------
// 剧情事件
// ---------------------------------------------------------------------------

/**
 * 剧情级事件的定义。
 *
 * 这类事件不属于任何单位，而是「发生在战场上」的 —— 从上方的事件区降临。
 * 海啸、地震、渡劫天雷都是这一类。damagePercent 为 0 时是纯演出。
 */
export interface StageEventDef {
  id: string;
  name: string;
  desc: string;
  /** 演出与日志用的文案。 */
  text: string;
  /** 按目标最大生命的百分比结算伤害；0 表示纯演出。 */
  damagePercent: number;
  kind: DamageKind;
  /** 演出配色。 */
  color: number;
}

// ---------------------------------------------------------------------------
// 指令与阶段
// ---------------------------------------------------------------------------

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
 * 顺序：deployment → turnStart → commandInput → statusSettlement → executeCommands
 *      → bothSidesAction → actionEnd → 下一回合。
 */
export type BattlePhase =
  /** 布阵：预览阵法、地形与场景，确认后开战。站位由阵法决定，此处不可更改。 */
  | 'deployment'
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
