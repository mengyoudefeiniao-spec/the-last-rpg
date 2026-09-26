import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BattleSnapshot, UnitSnapshot } from '../src/shared/protocol.ts';
import { BattleMirror } from '../src/client/state/battle-mirror.ts';

/**
 * 客户端镜像的测试。
 *
 * 专门盯一个很隐蔽的时序：**演出期间时间还在往前走**，
 * 所以「演出开始那一刻生成的快照」永远比此刻的心跳旧。
 * 一不留神拿它去覆盖，画面就会卡在过时状态上，而且自己不会恢复。
 */

function makeUnit(id: string, side: 'ally' | 'enemy', gauge: number): UnitSnapshot {
  return {
    id,
    name: id,
    side,
    stats: {
      hp: 100,
      maxHp: 100,
      mp: 0,
      maxMp: 0,
      sp: 0,
      maxSp: 0,
      atk: 10,
      def: 10,
      mag: 10,
      res: 10,
      spd: 30,
    },
    position: { x: 0, z: 0 },
    statuses: [],
    isDefending: false,
    captured: false,
    alive: true,
    isPlayerControlled: side === 'ally',
    gauge,
    gaugePerSecond: 30,
    awaitingCommand: false,
  };
}

/** 只填镜像层真正读的字段 —— 战场、阵法、场景那些外观数据与这里要验的行为无关。 */
function makeSnapshot(
  sessionId: string,
  awaitingUnitIds: string[],
  gauges: Record<string, number> = {},
): BattleSnapshot {
  return {
    sessionId,
    phase: 'battle',
    round: 1,
    units: [
      makeUnit('ally.a', 'ally', gauges['ally.a'] ?? 0),
      makeUnit('enemy.a', 'enemy', gauges['enemy.a'] ?? 0),
    ],
    awaitingUnitIds,
    log: [],
    result: null,
  } as unknown as BattleSnapshot;
}

test('演出期间新到点的单位，不会被「演出前生成的旧快照」抹掉', () => {
  const mirror = new BattleMirror();

  // ① 开战快照：还没人到点
  mirror.applySnapshot(makeSnapshot('s1', []));

  // ② 你出手后，服务端带着演出剧本推来一份快照 ——
  //    它是「出刀那一刻」生成的，名单里还是空的
  const stale = makeSnapshot('s1', []);

  // ③ 演出还在播，时间照走，凌霜到点了
  mirror.applyTick(
    [
      { unitId: 'ally.a', gauge: 100 },
      { unitId: 'enemy.a', gauge: 40 },
    ],
    ['ally.a'],
  );
  assert.deepEqual(
    mirror.awaitingUnits.map((unit) => unit.id),
    ['ally.a'],
    '心跳说有人到点，镜像就该认',
  );

  // ④ 演出播完，那份旧快照才被应用 —— 它不该把刚冒出来的凌霜抹掉
  mirror.applySnapshot(stale);

  assert.deepEqual(
    mirror.awaitingUnits.map((unit) => unit.id),
    ['ally.a'],
    '旧快照把演出期间新到点的单位抹掉了 —— 指令栏会因此再也不亮',
  );
});

test('换一局时名单要以新快照为准', () => {
  const mirror = new BattleMirror();
  mirror.applySnapshot(makeSnapshot('s1', []));
  mirror.applyTick([{ unitId: 'ally.a', gauge: 100 }], ['ally.a']);

  // 重开一局：旧名单必须丢掉，否则新战场上会凭空冒出一个等着指令的单位
  mirror.applySnapshot(makeSnapshot('s2', []));

  assert.deepEqual(mirror.awaitingUnitIds, [], '换了局就该听新快照的');
  assert.deepEqual(mirror.awaitingUnits, []);
});

test('有人等着指令时，行动条的插值一起停住', async () => {
  const mirror = new BattleMirror();
  mirror.applySnapshot(makeSnapshot('s1', []));
  mirror.applyTick(
    [
      { unitId: 'ally.a', gauge: 100 },
      { unitId: 'enemy.a', gauge: 50 },
    ],
    ['ally.a'],
  );

  const enemy = mirror.units.find((unit) => unit.id === 'enemy.a');
  assert.ok(enemy);

  const first = mirror.displayGauge(enemy);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = mirror.displayGauge(enemy);

  assert.equal(
    Math.round(second),
    Math.round(first),
    `等待指令期间条不该自己往前爬：${first} → ${second}`,
  );
});

test('没人等着指令时，行动条照常插值往前爬', async () => {
  const mirror = new BattleMirror();
  mirror.applySnapshot(makeSnapshot('s1', []));
  mirror.applyTick([{ unitId: 'enemy.a', gauge: 50 }], []);

  const enemy = mirror.units.find((unit) => unit.id === 'enemy.a');
  assert.ok(enemy);

  const first = mirror.displayGauge(enemy);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = mirror.displayGauge(enemy);

  assert.ok(
    second > first,
    `没人等指令时，条该按速度自己往前走：${first} → ${second}`,
  );
});
