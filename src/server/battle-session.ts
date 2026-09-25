import { getBattlefield, DEFAULT_BATTLEFIELD_ID } from '../shared/data/battlefields.ts';
import { createSampleBattleUnits } from '../shared/data/sample-battle.ts';
import type { ActiveStatus, BattleUnit, PendingAction } from '../shared/data/types.ts';
import type {
  BattleRecord,
  BattleSnapshot,
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

  /** 取出并清空 —— 每次同步只发「上次同步之后」新产生的事件。 */
  take(): BattleRecord[] {
    const taken = this.records;
    this.records = [];
    return taken;
  }
}

export interface SessionOptions {
  sessionId: string;
  battlefieldId?: string;
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
  private battle: Battle;
  private readonly director = new RecordingDirector();
  private busy = false;

  private constructor(id: string, battle: Battle) {
    this.id = id;
    this.battle = battle;
    battle.director = this.director;
    battle.start();
  }

  static create(options: SessionOptions): BattleSession {
    const battlefield = getBattlefield(options.battlefieldId ?? DEFAULT_BATTLEFIELD_ID);
    const units = createSampleBattleUnits().map(createUnit);
    const battle = new Battle({ units, battlefield, seed: options.seed });
    return new BattleSession(options.sessionId, battle);
  }

  /** 对外状态快照。 */
  snapshot(): BattleSnapshot {
    return {
      sessionId: this.id,
      phase: this.battle.phase,
      turn: this.battle.turn,
      battlefield: this.battle.battlefield,
      units: this.battle.units.map(toUnitSnapshot),
      awaitingUnitIds: this.battle.awaitingUnits.map((unit) => unit.id),
      log: [...this.battle.log],
      result: this.battle.result,
    };
  }

  /** 取出自上次同步以来新产生的演出记录。 */
  takeRecords(): BattleRecord[] {
    return this.director.take();
  }

  // -------------------------------------------------------------------------
  // 玩家意图 —— 服务端校验后才会改变状态
  // -------------------------------------------------------------------------

  /** 布阵阶段交换两个我方单位的站位。 */
  swapPositions(unitAId: string, unitBId: string): void {
    const ok = this.battle.swapPositions(unitAId, unitBId);
    if (!ok) throw new Error('现在不能交换站位（只允许在布阵阶段调整我方单位）');
  }

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
}

// ---------------------------------------------------------------------------
// Battle → 对外快照
// ---------------------------------------------------------------------------

function toUnitSnapshot(unit: BattleUnit): UnitSnapshot {
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

  // 指令可用性在服务端算一次，客户端照着显示 —— 避免客户端自己推一份规则
  if (unit.isPlayerControlled) {
    snapshot.commands = COMMAND_ORDER.map((id) => {
      const check = checkUsable(unit, getCommand(id));
      return check.ok ? { id, ok: true } : { id, ok: false, reason: check.reason };
    });
  }

  return snapshot;
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
