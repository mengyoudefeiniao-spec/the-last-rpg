import { BALANCE } from '../../shared/config/balance.ts';
import type {
  Battlefield,
  BattleLogEntry,
  BattlePhase,
  BattleResult,
  Formation,
} from '../../shared/data/types.ts';
import type {
  BattleRecord,
  BattleSnapshot,
  Scenery,
  UnitSnapshot,
} from '../../shared/protocol.ts';

/**
 * 客户端状态镜像。
 *
 * 它是服务端快照的**本地只读副本** —— 存在的唯一理由是渲染层需要一个同步、可反复读取的数据源。
 * 注意边界：这里没有任何战斗推导。血少了多少、谁先出手，全由服务端算完推过来，
 * 客户端连「这条命该扣几点」这种判断都不做。
 */
export class BattleMirror {
  sessionId = '';
  phase: BattlePhase = 'deployment';
  /** 轮次：全员各行动一次算一轮。 */
  round = 0;
  battlefield: Battlefield | null = null;
  /** 我方阵法 —— 阵位与阵图连线都从这里读。 */
  formation: Formation | null = null;
  /** 场景外观。服务端下发的完整数据，客户端不查表。 */
  scenery: Scenery | null = null;
  units: UnitSnapshot[] = [];
  awaitingUnitIds: string[] = [];
  log: BattleLogEntry[] = [];
  result: BattleResult | null = null;

  /** 演出进行中为 true —— UI 据此锁住输入，行动条也停着。 */
  playing = false;

  /**
   * 演出期间的血量覆盖。
   * 播放 strike 记录时把血条拨到该记录结算后的值，让血条和动画同步；
   * 快照一到就整体对齐并清空。
   */
  private readonly hpOverride = new Map<string, number>();

  /**
   * 行动值的插值基点。
   *
   * 服务端每 100ms 才报一次，照它直接画的话条会一跳一跳；
   * 所以记下「上次收到的值 + 收到的时刻」，渲染时按 gaugePerSecond 往前推。
   * 这只是表现层的补间 —— 谁该行动永远由服务端说了算。
   */
  private readonly gaugeBase = new Map<string, { value: number; at: number }>();

  applySnapshot(snapshot: BattleSnapshot): void {
    this.sessionId = snapshot.sessionId;
    this.phase = snapshot.phase;
    this.round = snapshot.round;
    this.battlefield = snapshot.battlefield;
    this.formation = snapshot.formation;
    this.scenery = snapshot.scenery;
    this.units = snapshot.units;
    this.awaitingUnitIds = snapshot.awaitingUnitIds;
    this.log = snapshot.log;
    this.result = snapshot.result;
    this.hpOverride.clear();

    for (const unit of snapshot.units) this.markGauge(unit.id, unit.gauge);
  }

  /** 应用一次行动条心跳。 */
  applyTick(gauges: ReadonlyArray<{ unitId: string; gauge: number }>, awaitingUnitIds: string[]): void {
    for (const entry of gauges) this.markGauge(entry.unitId, entry.gauge);
    this.awaitingUnitIds = awaitingUnitIds;

    // 心跳里带到了「谁可以操作」，把单位快照也顺手对齐
    for (const unit of this.units) {
      unit.awaitingCommand = awaitingUnitIds.includes(unit.id);
    }
  }

  private markGauge(unitId: string, value: number): void {
    this.gaugeBase.set(unitId, { value, at: performance.now() });
  }

  /**
   * 显示用的行动值：两次心跳之间按速度插值补平，条才走得顺。
   *
   * 注意**演出期间也照常插值** —— 行动条本就该在别人动手时继续走，
   * 那种「画面在演、条还在涨」的压迫感正是 ATB 的核心。
   */
  displayGauge(unit: UnitSnapshot): number {
    const base = this.gaugeBase.get(unit.id);
    if (!base) return unit.gauge;
    if (unit.awaitingCommand) return base.value;

    const elapsed = (performance.now() - base.at) / 1000;
    return Math.min(BALANCE.gaugeMax, base.value + unit.gaugePerSecond * elapsed);
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

  /**
   * 当前等待指令的我方单位。
   * 这份名单完全由服务端决定 —— 行动条没满的单位根本不在这里。
   */
  get awaitingUnits(): UnitSnapshot[] {
    if (this.finished) return [];
    return this.awaitingUnitIds
      .map((id) => this.unitById(id))
      .filter((unit): unit is UnitSnapshot => unit !== undefined);
  }
}
