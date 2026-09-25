import type {
  Battlefield,
  BattleLogEntry,
  BattlePhase,
  BattlePosition,
  BattleResult,
  CommandId,
  EnvironmentTheme,
  Formation,
  PendingAction,
  Side,
  Stats,
  WeatherPreset,
} from './data/types.ts';

/**
 * 前后端协议。
 *
 * 原则：服务端是唯一权威。客户端只能发「意图」（换阵、开战、下指令、触发事件），
 * 所有战斗状态一律由服务端下发，客户端不许自己算任何战斗结果。
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// 状态快照（服务端 → 客户端）
// ---------------------------------------------------------------------------

export interface StatusSnapshot {
  id: string;
  name: string;
  kind: 'buff' | 'debuff';
  remaining: number;
  desc: string;
  /** 是否由地形施加 —— UI 要把它和技能造成的状态区分开显示。 */
  fromTerrain: boolean;
}

/** 一条指令对某个单位是否可用 —— 由服务端算好，客户端照显示。 */
export interface CommandAvailability {
  id: CommandId;
  ok: boolean;
  /** 不可用的原因，客户端直接拿去当按钮提示。 */
  reason?: string;
}

/** 单位的对外投影。只带客户端渲染需要的东西，内部字段不外泄。 */
export interface UnitSnapshot {
  id: string;
  name: string;
  side: Side;
  stats: Stats;
  position: BattlePosition;
  statuses: StatusSnapshot[];
  isDefending: boolean;
  captured: boolean;
  alive: boolean;
  isPlayerControlled: boolean;
  /** 所站阵位的角色名（如「锋头」），只有我方有。 */
  formationRole?: string;
  /**
   * 指令可用性，只对我方单位下发。
   * 「这个特技现在能不能放」是规则判断，客户端不该自己推一份 —— 那是双份真源的开始。
   */
  commands?: CommandAvailability[];
}

/**
 * 场景外观。
 * 服务端把**完整数据**下发，而不是只给 id 让客户端去查表 ——
 * 这样客户端手里那份永远是服务端认定的那一份，不会因为版本错位而画错。
 */
export interface Scenery {
  environment: EnvironmentTheme;
  weather: WeatherPreset;
}

/** 完整战斗状态。客户端收到后直接镜像，不做二次推导。 */
export interface BattleSnapshot {
  sessionId: string;
  phase: BattlePhase;
  turn: number;
  battlefield: Battlefield;
  /** 我方当前阵法。站位、阵图连线都在里面。 */
  formation: Formation;
  /** 场景外观（只影响观感）。 */
  scenery: Scenery;
  units: UnitSnapshot[];
  /** 正在等待指令的我方单位 id（按下达顺序）。 */
  awaitingUnitIds: string[];
  log: BattleLogEntry[];
  result: BattleResult | null;
}

// ---------------------------------------------------------------------------
// 演出记录（服务端 → 客户端）
// ---------------------------------------------------------------------------

/**
 * 服务端跑完一次推进后产生的事件流，客户端按顺序播成动画。
 *
 * 职责划分很明确：**记录只说明「怎么演」，快照才说明「是什么」**。
 * 记录里带 hpAfter 是为了让血条能在动画播到那一刻同步变化，
 * 但记录本身不承担状态权威 —— 播完一律用随行的 snapshot 校正。
 */
export type BattleRecord =
  | { kind: 'turnStart'; turn: number }
  | { kind: 'beforeAction'; actorId: string; commandId: CommandId; targetId: string | null }
  | {
      kind: 'strike';
      /** DoT 之类没有攻击者时为 null。 */
      actorId: string | null;
      targetId: string;
      damage: number;
      healing: number;
      crit: boolean;
      defeated: boolean;
      label: string;
      /** 结算后的剩余 HP，客户端据此让血条与动画同步。 */
      hpAfter: number;
    }
  | { kind: 'status'; unitId: string; name: string; statusKind: 'buff' | 'debuff' }
  | { kind: 'afterAction'; actorId: string }
  /**
   * 剧情级事件（天雷、地震、海啸……）。
   * 演出锚点在战场上方的事件区 —— 那块区域目前不渲染，只作为降临位置。
   */
  | {
      kind: 'stageEvent';
      eventId: string;
      name: string;
      /** 演出时显示在日志与画面上的文案。 */
      text: string;
      anchor: { x: number; y: number; z: number };
    };

// ---------------------------------------------------------------------------
// 客户端 → 服务端
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** 进入战斗。阵法 / 战场 / 场景一律用服务端存好的队伍配置。 */
  | { type: 'join'; seed?: number }
  /**
   * 保存队伍配置（阵法、战场、环境、天气），并立刻按新配置重开一局。
   * 之所以「保存 + 重开」绑在一起：阵法与场景都是战斗外的设定，
   * 战斗中换它们等于换一场仗，不如重开干净。
   */
  | { type: 'savePartyConfig'; formationId?: string; battlefieldId?: string; environmentId?: string; weatherId?: string }
  /** 布阵完成，开打。 */
  | { type: 'beginBattle' }
  /** 提交一整回合的指令。 */
  | { type: 'submitCommands'; actions: PendingAction[] }
  /** 手动触发一个剧情事件（目前只有天雷，用于验证事件链路）。 */
  | { type: 'triggerEvent'; eventId: string }
  /** 重开一局（沿用当前配置）。 */
  | { type: 'restart'; seed?: number };

// ---------------------------------------------------------------------------
// 服务端 → 客户端
// ---------------------------------------------------------------------------

export type ServerMessage =
  /**
   * 一次状态同步：先按 records 播演出，播完以 snapshot 为准。
   * 连接建立时 records 为空，只带初始快照。
   */
  | { type: 'snapshot'; snapshot: BattleSnapshot; records: BattleRecord[] }
  | { type: 'error'; message: string };

/** 供服务端与客户端共用的快速判断。 */
export function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    ((value as { type: unknown }).type === 'snapshot' ||
      (value as { type: unknown }).type === 'error')
  );
}
