import { getBattlefield } from '../shared/data/battlefields.ts';
import { getEnvironment, getWeather } from '../shared/data/environments.ts';
import { getFormation } from '../shared/data/formations.ts';
import { createSampleBattleUnits } from '../shared/data/sample-battle.ts';
import { getStageEvent } from '../shared/data/stage-events.ts';
import type {
  ActiveStatus,
  BattleUnit,
  PartyConfig,
  PendingAction,
  StageEventDef,
} from '../shared/data/types.ts';
import type {
  BattleRecord,
  BattleSnapshot,
  Scenery,
  StatusSnapshot,
  UnitSnapshot,
} from '../shared/protocol.ts';
import {
  Battle,
  type BattleDirector,
  type StatusReport,
  type StrikeReport,
} from '../shared/systems/battle/battle.ts';
import { createUnit, isAlive } from '../shared/systems/battle/battle-unit.ts';
import { COMMAND_ORDER, checkUsable, getCommand } from '../shared/systems/battle/commands.ts';
import { isTerrainStatus } from '../shared/systems/battle/terrain.ts';

/**
 * 演出记录器 —— 服务端权威能成立的关键一步。
 *
 * 它实现 BattleDirector，但什么都不演，只把动作点记成一串事件。
 * Battle 完全不知道对面是浏览器还是记录器：它照旧在每个动作点 await，
 * 而这里同步 return，于是整个回合一口气算完，产出一份可供客户端播放的剧本。
 */
class RecordingDirector implements BattleDirector {
  private records: BattleRecord[] = [];

  onTurnStart(turn: number): void {
    this.records.push({ kind: 'turnStart', turn });
  }

  beforeAction(actor: BattleUnit, action: PendingAction, target: BattleUnit | undefined): void {
    this.records.push({
      kind: 'beforeAction',
      actorId: actor.id,
      commandId: action.commandId,
      targetId: target?.id ?? null,
    });
  }

  onStrike(report: StrikeReport): void {
    this.records.push({
      kind: 'strike',
      actorId: report.attacker?.id ?? null,
      targetId: report.target.id,
      damage: report.damage,
      healing: report.healing,
      crit: report.crit,
      defeated: report.defeated,
      label: report.label,
      hpAfter: Math.max(0, report.target.stats.hp),
    });
  }

  onStatus(report: StatusReport): void {
    this.records.push({
      kind: 'status',
      unitId: report.unit.id,
      name: report.name,
      statusKind: report.kind,
    });
  }

  afterAction(actor: BattleUnit): void {
    this.records.push({ kind: 'afterAction', actorId: actor.id });
  }

  onStageEvent(
    def: StageEventDef,
    _targets: BattleUnit[],
    anchor: { x: number; y: number; z: number },
  ): void {
    this.records.push({
      kind: 'stageEvent',
      eventId: def.id,
      name: def.name,
      text: def.text,
      anchor: { ...anchor },
    });
  }

  /** 取出并清空 —— 每次同步只发「上次同步之后」新产生的事件。 */
  take(): BattleRecord[] {
    const records = this.records;
    this.records = [];
    return records;
  }
}

export interface SessionOptions {
  sessionId: string;
  /** 战斗外配好的队伍设置：阵法、战场、环境、天气，全在这里。 */
  config: PartyConfig;
  seed?: number;
}

/**
 * 一场战斗的服务端会话。
 *
 * 它是这个游戏目前唯一的「全局缓存」：权威状态全在这里，
 * 客户端手上那份 snapshot 只是投影。任何状态变更都必须走这里的方法，
 * 客户端没有旁路 —— 这是避免「后期扩展出不可修复 bug」的结构性保证。
 */
export class BattleSession {
  readonly id: string;
  /** 开战时从队伍配置里读出来的那一份，战斗中不变。 */
  readonly config: PartyConfig;

  private battle: Battle;
  private readonly director = new RecordingDirector();
  private busy = false;

  private constructor(id: string, config: PartyConfig, battle: Battle) {
    this.id = id;
    this.config = config;
    this.battle = battle;
    battle.director = this.director;
    battle.start();
  }

  static create(options: SessionOptions): BattleSession {
    const config = options.config;
    const battlefield = getBattlefield(config.battlefieldId);
    const formation = getFormation(config.formationId);
    const units = createSampleBattleUnits().map(createUnit);

    const battle = new Battle({ units, battlefield, formation, seed: options.seed });
    return new BattleSession(options.sessionId, config, battle);
  }

  /** 对外状态快照。 */
  snapshot(): BattleSnapshot {
    return {
      sessionId: this.id,
      phase: this.battle.phase,
      turn: this.battle.turn,
      battlefield: this.battle.battlefield,
      formation: this.battle.formation,
      scenery: this.scenery(),
      units: this.battle.units.map((unit) => this.toUnitSnapshot(unit)),
      awaitingUnitIds: this.battle.awaitingUnits.map((unit) => unit.id),
      log: [...this.battle.log],
      result: this.battle.result,
    };
  }

  /** 场景外观。服务端下发完整数据，客户端不必自己查表。 */
  private scenery(): Scenery {
    return {
      environment: getEnvironment(this.config.environmentId),
      weather: getWeather(this.config.weatherId),
    };
  }

  /** 取出自上次同步以来新产生的演出记录。 */
  takeRecords(): BattleRecord[] {
    return this.director.take();
  }

  // -------------------------------------------------------------------------
  // 玩家意图 —— 服务端校验后才会改变状态
  // -------------------------------------------------------------------------

  async beginBattle(): Promise<void> {
    if (this.battle.phase !== 'deployment') throw new Error('当前不在布阵阶段');
    await this.battle.beginBattle();
  }

  async submitCommands(actions: readonly PendingAction[]): Promise<void> {
    if (this.busy) throw new Error('上一轮仍在结算中，请稍候');
    if (this.battle.phase !== 'commandInput') {
      throw new Error(`当前阶段是 ${this.battle.phase}，不接受指令`);
    }

    this.busy = true;
    try {
      await this.battle.submit(actions);
    } finally {
      this.busy = false;
    }
  }

  /** 手动触发一个剧情事件（目前只有演示用的天雷）。 */
  async triggerEvent(eventId: string): Promise<void> {
    if (this.busy) throw new Error('上一轮仍在结算中，请稍候');

    const def = getStageEvent(eventId);
    this.busy = true;
    try {
      await this.battle.triggerStageEvent(def);
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------------------------

  private toUnitSnapshot(unit: BattleUnit): UnitSnapshot {
    const snapshot: UnitSnapshot = {
      id: unit.id,
      name: unit.name,
      side: unit.side,
      stats: { ...unit.stats },
      position: { ...unit.position },
      statuses: unit.statuses.map(toStatusSnapshot),
      isDefending: unit.isDefending,
      captured: unit.captured,
      alive: isAlive(unit),
      isPlayerControlled: unit.isPlayerControlled,
    };

    if (unit.isPlayerControlled) {
      // 指令可用性在服务端算一次，客户端照着显示 —— 避免客户端自己推一份规则
      snapshot.commands = COMMAND_ORDER.map((id) => {
        const check = checkUsable(unit, getCommand(id));
        return check.ok ? { id, ok: true } : { id, ok: false, reason: check.reason };
      });

      const slot = this.battle.formationSlotOf(unit.id);
      if (slot) snapshot.formationRole = slot.role;
    }

    return snapshot;
  }
}

function toStatusSnapshot(status: ActiveStatus): StatusSnapshot {
  return {
    id: status.def.id,
    name: status.def.name,
    kind: status.def.kind,
    remaining: status.remaining,
    desc: status.def.desc,
    fromTerrain: isTerrainStatus(status),
  };
}
