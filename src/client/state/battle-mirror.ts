import type {
  Battlefield,
  BattleLogEntry,
  BattlePhase,
  BattleResult,
} from '../../shared/data/types.ts';
import type { BattleRecord, BattleSnapshot, UnitSnapshot } from '../../shared/protocol.ts';

/**
 * 客户端状态镜像。
 *
 * 它是服务端快照的**本地只读副本** —— 存在的唯一理由是渲染层需要一个同步、可反复读取的数据源。
 * 注意边界：这里没有任何战斗推导。血少了多少、谁先出手，全由服务端算完推过来，
 * 客户端连"这条命该扣几点"这种判断都不做。
 */
export class BattleMirror {
  sessionId = '';
  phase: BattlePhase = 'deployment';
  turn = 0;
  battlefield: Battlefield | null = null;
  units: UnitSnapshot[] = [];
  awaitingUnitIds: string[] = [];
  log: BattleLogEntry[] = [];
  result: BattleResult | null = null;

  /** 演出进行中为 true —— UI 据此锁住输入，避免演到一半又提交一轮。 */
  playing = false;

  /**
   * 演出期间的血量覆盖。
   * 播放 strike 记录时把血条拨到该记录结算后的值，让血条和动画同步；
   * 快照一到就整体对齐并清空。
   */
  private readonly hpOverride = new Map<string, number>();

  applySnapshot(snapshot: BattleSnapshot): void {
    this.sessionId = snapshot.sessionId;
    this.phase = snapshot.phase;
    this.turn = snapshot.turn;
    this.battlefield = snapshot.battlefield;
    this.units = snapshot.units;
    this.awaitingUnitIds = snapshot.awaitingUnitIds;
    this.log = snapshot.log;
    this.result = snapshot.result;
    this.hpOverride.clear();
  }

  /** 播放一条演出记录时的即时反应。 */
  applyRecord(record: BattleRecord): void {
    if (record.kind === 'strike') {
      this.hpOverride.set(record.targetId, record.hpAfter);
    }
  }

  /** 显示用 HP：演出期间优先用覆盖值。 */
  displayHp(unit: UnitSnapshot): number {
    return this.hpOverride.get(unit.id) ?? unit.stats.hp;
  }

  unitById(id: string): UnitSnapshot | undefined {
    return this.units.find((unit) => unit.id === id);
  }

  get allies(): UnitSnapshot[] {
    return this.units.filter((unit) => unit.side === 'ally');
  }

  get enemies(): UnitSnapshot[] {
    return this.units.filter((unit) => unit.side === 'enemy');
  }

  get finished(): boolean {
    return this.result !== null;
  }

  /** 当前等待指令的我方单位（按服务端给的顺序）。 */
  get awaitingUnits(): UnitSnapshot[] {
    if (this.phase !== 'commandInput' || this.finished) return [];
    return this.awaitingUnitIds
      .map((id) => this.unitById(id))
      .filter((unit): unit is UnitSnapshot => unit !== undefined);
  }

  /** 布阵阶段可交换站位的是全部存活的我方单位。 */
  get deployableUnits(): UnitSnapshot[] {
    if (this.phase !== 'deployment') return [];
    return this.allies.filter((unit) => unit.alive);
  }
}
