import { BALANCE } from '../../shared/config/balance.ts';

/** 对齐偏差用多久化掉（秒）。太短等于没做，太长会看着发飘。 */
const GAUGE_SETTLE_SECONDS = 0.45;
/** 偏差限幅：超过这么多就不平滑了，直接跳 —— 换局、复活这类真落差该干脆。 */
const GAUGE_SHIFT_LIMIT = 8;
import type {
  Battlefield,
  BattleLogEntry,
  BattlePhase,
  BattleResult,
  Formation,
  ItemStack,
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
  /** 队伍共用的道具池。全队一份，不是每人一个背包。 */
  items: ItemStack[] = [];
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
   *
   * `shift` 是上一次对齐时欠下的偏差：心跳间隔本身有抖动，硬贴着真实值跳
   * 会看见「一顿一顿」。所以把差额记下来，交给后面半秒慢慢化掉。
   */
  private readonly gaugeBase = new Map<
    string,
    { value: number; at: number; shift: number }
  >();

  applySnapshot(snapshot: BattleSnapshot): void {
    const isNewSession = snapshot.sessionId !== this.sessionId;

    this.sessionId = snapshot.sessionId;
    this.phase = snapshot.phase;
    this.round = snapshot.round;
    this.battlefield = snapshot.battlefield;
    this.formation = snapshot.formation;
    this.scenery = snapshot.scenery;
    this.units = snapshot.units;
    this.items = snapshot.items;

    // 「谁在等指令」这份名单**只由心跳维护**。
    // 快照是服务端产出演出剧本那一刻生成的，而演出期间时间还在往前走 ——
    // 拿它盖回来，就会把演出中新到点的单位抹掉，指令栏于是再也不肯亮。
    if (isNewSession) this.awaitingUnitIds = snapshot.awaitingUnitIds;

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

  /**
   * 记下一个单位的新行动值。
   *
   * 两条规矩，都是为了让条看着稳：
   * 1. 小幅回退不认 —— 那是心跳间隔抖动，不是真的退回去了；
   * 2. 与当前显示值的差额存进 `shift`，交给后面慢慢化掉，而不是当场跳过去。
   */
  private markGauge(unitId: string, value: number): void {
    const now = performance.now();
    const previous = this.gaugeBase.get(unitId);

    if (previous && value < previous.value && previous.value - value < BALANCE.gaugeMax * 0.5) {
      return;
    }

    const speed = this.unitById(unitId)?.gaugePerSecond ?? 0;

    // 不校正的话，此刻屏幕上画到哪里
    const shown = previous
      ? previous.value +
        speed * ((now - previous.at) / 1000) +
        previous.shift * Math.max(0, 1 - (now - previous.at) / 1000 / GAUGE_SETTLE_SECONDS)
      : value;

    // 偏差限幅：真出现大落差（换局、复活），那就该干脆地跳，别拖泥带水
    const shift = Math.max(-GAUGE_SHIFT_LIMIT, Math.min(GAUGE_SHIFT_LIMIT, shown - value));

    this.gaugeBase.set(unitId, { value, at: now, shift });
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

    /*
     * 两种情况条都该是死的，不插值：
     * - 布阵阶段：服务端这时不推进，客户端要是自己往前爬，每来一次心跳就被打回 0，
     *   看着就是「爬一下、弹回去」地抖；
     * - 有人在等我方指令：整个战场的时间停住。
     */
    if (this.phase !== 'battle' || this.awaitingUnitIds.length > 0) return base.value;

    const elapsed = (performance.now() - base.at) / 1000;
    const settle = Math.max(0, 1 - elapsed / GAUGE_SETTLE_SECONDS);

    return Math.max(
      0,
      Math.min(
        BALANCE.gaugeMax,
        base.value + unit.gaugePerSecond * elapsed + base.shift * settle,
      ),
    );
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
