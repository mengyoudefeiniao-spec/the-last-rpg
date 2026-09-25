import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRng } from '../src/shared/core/rng.ts';
import { getBattlefield } from '../src/shared/data/battlefields.ts';
import { getFormation, listFormations } from '../src/shared/data/formations.ts';
import { createSampleBattleUnits } from '../src/shared/data/sample-battle.ts';
import { getStatusDef } from '../src/shared/data/statuses.ts';
import type { BattlePhase } from '../src/shared/data/types.ts';
import { Battle } from '../src/shared/systems/battle/battle.ts';
import {
  createUnit,
  isAlive,
  resolveAttack,
  type DamageSpec,
} from '../src/shared/systems/battle/battle-unit.ts';
import { applyStatus } from '../src/shared/systems/battle/status-effects.ts';
import { zoneAt } from '../src/shared/systems/battle/terrain.ts';

const MAX_TURNS = 200;

/** 不带地形的战斗 —— 测的是基本规则，别让地形效果混进来。 */
function makeBattle(seed: number): Battle {
  return new Battle({ units: createSampleBattleUnits().map(createUnit), seed });
}

/** 指定战场的一局。默认摆锋矢阵 —— 阵法现在决定我方站位。 */
function makeBattleOn(
  battlefieldId: string,
  seed: number,
  formationId = 'arrow-head',
): Battle {
  return new Battle({
    units: createSampleBattleUnits().map(createUnit),
    battlefield: getBattlefield(battlefieldId),
    formation: getFormation(formationId),
    seed,
  });
}

/**
 * 一路自动打到结束。
 * 不挂 director，所以所有演出 await 都被跳过 —— 战斗瞬间跑完，这正是测试要的。
 */
async function runToEnd(battle: Battle): Promise<Battle> {
  battle.start();
  await battle.beginBattle();

  let guard = 0;
  while (!battle.finished) {
    assert.equal(battle.phase, 'commandInput', '战斗未结束时应当停在指令阶段等待输入');
    guard += 1;
    if (guard > MAX_TURNS) throw new Error(`超过 ${MAX_TURNS} 回合仍未分出胜负`);

    await battle.submit(battle.autoCommand());
  }

  assert.notEqual(battle.phase, 'commandInput', '结束后不应停留在指令阶段');
  return battle;
}

test('同一套数据能打完一场完整战斗，且我方整体占优', async () => {
  const outcomes = new Map<string, number>();

  for (let seed = 1; seed <= 30; seed += 1) {
    const battle = await runToEnd(makeBattle(seed));
    const outcome = battle.result?.outcome ?? 'none';
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);

    assert.ok((battle.result?.turns ?? 0) >= 2, `seed=${seed} 的回合数不合理`);
    assert.ok(battle.log.length > 10, `seed=${seed} 的日志过少，可能没真的打起来`);
  }

  const wins = outcomes.get('victory') ?? 0;
  assert.ok(
    wins >= 24,
    `30 场里只赢了 ${wins} 场，数值可能失衡：${JSON.stringify([...outcomes])}`,
  );
});

test('一个回合内的阶段顺序与设计一致', async () => {
  const battle = makeBattle(7);
  const phases: BattlePhase[] = [];
  battle.events.on('phase', (phase) => phases.push(phase));

  battle.start();
  await battle.beginBattle();
  phases.length = 0; // 只关心一个完整回合的循环

  await battle.submit(battle.autoCommand());

  assert.deepEqual(phases, [
    'statusSettlement',
    'executeCommands',
    'bothSidesAction',
    'actionEnd',
    'turnStart',
    'commandInput',
  ]);
});

test('HP / MP / SP 全程不越界', async () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const battle = await runToEnd(makeBattle(seed));

    for (const unit of battle.units) {
      const { hp, maxHp, mp, maxMp, sp, maxSp } = unit.stats;
      assert.ok(hp >= 0 && hp <= maxHp, `${unit.name} 的 HP 越界：${hp}/${maxHp}`);
      assert.ok(mp >= 0 && mp <= maxMp, `${unit.name} 的 MP 越界：${mp}/${maxMp}`);
      assert.ok(sp >= 0 && sp <= maxSp, `${unit.name} 的 SP 越界：${sp}/${maxSp}`);
    }
  }
});

test('状态效果到期后会在行动结束判定阶段被移除', async () => {
  const battle = makeBattle(3);
  battle.start();
  await battle.beginBattle();

  const boss = battle.units.find((unit) => unit.id === 'enemy.chieftain');
  assert.ok(boss, '找不到山魈首领');

  applyStatus(boss, getStatusDef('poison'), 'test', 1);
  assert.equal(boss.statuses.length, 1);

  await battle.submit(battle.autoCommand());

  assert.ok(
    !boss.statuses.some((status) => status.def.id === 'poison'),
    '只持续 1 回合的中毒应当已经被移除',
  );
});

test('防御姿态能显著降低受到的伤害', () => {
  const spec: DamageSpec = { kind: 'physical', mult: 1, canCrit: false, label: '测试' };

  const attacker = createUnit({
    id: 'test.attacker',
    name: '测试攻击者',
    side: 'ally',
    stats: { maxHp: 100, maxMp: 0, maxSp: 0, atk: 50, def: 10, spd: 10 },
  });
  const plain = createUnit({
    id: 'test.plain',
    name: '未防御',
    side: 'enemy',
    stats: { maxHp: 500, maxMp: 0, maxSp: 0, def: 20, res: 0, spd: 5 },
  });
  const guarded = createUnit({
    id: 'test.guarded',
    name: '防御中',
    side: 'enemy',
    stats: { maxHp: 500, maxMp: 0, maxSp: 0, def: 20, res: 0, spd: 5 },
  });
  guarded.isDefending = true;

  // 同一个 seed 让两次随机序列完全一致，差异只可能来自防御姿态。
  const hitPlain = resolveAttack(attacker, plain, spec, createRng(99));
  const hitGuarded = resolveAttack(attacker, guarded, spec, createRng(99));

  assert.ok(hitPlain.dealt > 0, '未防御时应当受到伤害');
  assert.ok(
    hitGuarded.dealt < hitPlain.dealt,
    `防御后伤害应更低：${hitGuarded.dealt} vs ${hitPlain.dealt}`,
  );
});

test('受击会积累愤怒（SP）', () => {
  const target = createUnit({
    id: 'test.target',
    name: '沙包',
    side: 'enemy',
    stats: { maxHp: 1000, maxMp: 0, maxSp: 100, sp: 0, def: 0, res: 0, spd: 1 },
  });
  const attacker = createUnit({
    id: 'test.attacker',
    name: '打手',
    side: 'ally',
    stats: { maxHp: 100, maxMp: 0, maxSp: 0, atk: 60, spd: 10 },
  });

  const outcome = resolveAttack(
    attacker,
    target,
    { kind: 'physical', mult: 1, label: '测试' },
    createRng(7),
  );

  assert.ok(outcome.dealt > 0);
  assert.ok(outcome.spGained > 0, '受击应当获得愤怒');
  assert.ok(target.stats.sp <= target.stats.maxSp, '愤怒不应超过上限');
});

test('逃跑成功会立即结束战斗', async () => {
  let fled = false;

  for (let seed = 1; seed <= 60 && !fled; seed += 1) {
    const battle = makeBattle(seed);
    battle.start();
    await battle.beginBattle();

    const actor = battle.awaitingUnits[0];
    assert.ok(actor, '首个回合应当有可操作的我方单位');

    await battle.submit([{ actorId: actor.id, commandId: 'flee' }]);
    if (battle.result?.outcome === 'fled') fled = true;
  }

  assert.ok(fled, '60 个种子都没能逃跑成功，逃跑概率可能算错了');
});

test('挂了 director 时，演出点会被依次回调', async () => {
  const battle = makeBattle(11);
  const calls: string[] = [];

  battle.director = {
    onTurnStart: () => {
      calls.push('turnStart');
    },
    beforeAction: (actor) => {
      calls.push(`before:${actor.id}`);
    },
    onStrike: () => {
      calls.push('strike');
    },
    afterAction: (actor) => {
      calls.push(`after:${actor.id}`);
    },
  };

  battle.start();
  await battle.beginBattle();
  calls.length = 0;
  await battle.submit(battle.autoCommand());

  assert.ok(calls.includes('turnStart'), '回合开始应当回调 onTurnStart');
  assert.ok(calls.some((call) => call.startsWith('before:')), '至少应当有一次行动前摇');
  assert.ok(calls.includes('strike'), '行动期间应当有伤害回调');

  // 每个 before 都要配一个同名的 after，否则演出层会漏归位
  const befores = calls.filter((call) => call.startsWith('before:')).map((c) => c.slice(7));
  const afters = calls.filter((call) => call.startsWith('after:')).map((c) => c.slice(6));
  assert.deepEqual(afters, befores, 'beforeAction 与 afterAction 必须成对');
});

// ---------------------------------------------------------------------------
// 布阵与地形
// ---------------------------------------------------------------------------

test('阵法决定我方站位，敌方用战场自带的槽位', () => {
  const battle = makeBattleOn('snow-ridge', 1);
  battle.start();

  assert.equal(battle.phase, 'deployment', '开局应当停在布阵阶段');

  const formation = battle.formation;
  const allies = battle.units.filter((unit) => unit.side === 'ally');
  assert.ok(formation.slots.length > 0, '阵法应当定义了阵位');
  assert.equal(allies.length, formation.slots.length, '我方人数应当与阵位数一致');

  allies.forEach((unit, index) => {
    const slot = formation.slots[index];
    assert.ok(slot, `第 ${index + 1} 号单位应当有对应阵位`);
    assert.equal(unit.position.x, slot.x, `${unit.name} 应当落在阵位上`);
    assert.equal(unit.position.z, slot.z, `${unit.name} 应当落在阵位上`);
  });

  // 敌方不设阵法
  const enemies = battle.units.filter((unit) => unit.side === 'enemy');
  const enemySlots = battle.battlefield.enemySlots;
  enemies.forEach((unit, index) => {
    const slot = enemySlots[index];
    assert.ok(slot, `敌方第 ${index + 1} 号应当有槽位`);
    assert.equal(unit.position.x, slot.x);
    assert.equal(unit.position.z, slot.z);
  });
});

test('换一个阵法，站位会变，踩进地形的人数也随之变化', () => {
  const build = (formationId: string): Battle =>
    new Battle({
      units: createSampleBattleUnits().map(createUnit),
      battlefield: getBattlefield('snow-ridge'),
      formation: getFormation(formationId),
      seed: 3,
    });

  const positionsOf = (battle: Battle): string[] =>
    battle.units
      .filter((unit) => unit.side === 'ally')
      .map((unit) => `${unit.position.x},${unit.position.z}`);

  const arrow = build('arrow-head');
  const snake = build('long-snake');
  assert.notDeepEqual(positionsOf(arrow), positionsOf(snake), '不同阵法的落点应当不同');

  const frozenCount = (battle: Battle): number =>
    battle.units.filter(
      (unit) => unit.side === 'ally' && zoneAt(battle.battlefield, unit.position) !== undefined,
    ).length;

  const counts = ['arrow-head', 'crane-wing', 'fish-scale', 'long-snake', 'square-circle'].map(
    (id) => frozenCount(build(id)),
  );

  assert.ok(
    new Set(counts).size > 1,
    `五个阵法踩进冻伤区的人数不该完全相同，否则阵法只是摆设：${JSON.stringify(counts)}`,
  );
});

test('每种阵法都有自己的阵图连线，且连线不指向不存在的阵位', () => {
  for (const formation of listFormations()) {
    assert.ok(formation.slots.length > 0, `${formation.name} 应当有阵位`);
    assert.ok(formation.links.length > 0, `${formation.name} 应当有阵图连线`);

    for (const link of formation.links) {
      assert.ok(
        link.from >= 0 && link.from < formation.slots.length,
        `${formation.name} 的连线起点越界`,
      );
      assert.ok(
        link.to >= 0 && link.to < formation.slots.length,
        `${formation.name} 的连线终点越界`,
      );
      assert.notEqual(link.from, link.to, `${formation.name} 的连线不该自己连自己`);
    }
  }
});

test('地形状态只给站在区域内的单位', async () => {
  const battle = makeBattleOn('snow-ridge', 5);
  battle.start();
  await battle.beginBattle();

  let covered = 0;
  for (const unit of battle.units) {
    if (!isAlive(unit)) continue;

    const inZone = zoneAt(battle.battlefield, unit.position) !== undefined;
    const hasFrostbite = unit.statuses.some((status) => status.def.id === 'frostbite');

    assert.equal(
      hasFrostbite,
      inZone,
      `${unit.name} 的地形状态与站位不符（圈内=${inZone}，冻伤=${hasFrostbite}）`,
    );
    if (inZone) covered += 1;
  }

  assert.ok(covered > 0, '雪山战场上应当至少有一个单位站在冻伤区里');
});

test('走出地形区域后，地形状态会在下一回合被清除', async () => {
  const battle = makeBattleOn('snow-ridge', 5);
  battle.start();
  await battle.beginBattle();

  const target = battle.units.find(
    (unit) => unit.side === 'ally' && zoneAt(battle.battlefield, unit.position) !== undefined,
  );
  assert.ok(target, '找不到站在冻伤区里的我方单位');
  assert.ok(
    target.statuses.some((status) => status.def.id === 'frostbite'),
    '站在冻伤区里却没有获得冻伤',
  );

  // 直接改坐标来模拟「因故离开区域」：正式玩法里只有布阵能换位，
  // 这里测的是同步逻辑本身 —— 它不该依赖换位这条路径。
  target.position = { x: 0, z: 0 };
  await battle.submit(battle.autoCommand());

  assert.ok(
    !target.statuses.some((status) => status.def.id === 'frostbite'),
    '离开区域后冻伤应当消退',
  );
});

test('三个战场都能打完一整场', async () => {
  for (const id of ['snow-ridge', 'flame-rift', 'immortal-spring']) {
    const battle = await runToEnd(makeBattleOn(id, 9));
    assert.ok(battle.result, `战场 ${id} 没能分出胜负`);
    assert.ok((battle.result?.turns ?? 0) >= 2, `战场 ${id} 的回合数不合理`);
  }
});
