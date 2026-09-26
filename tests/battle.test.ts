import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BALANCE } from '../src/shared/config/balance.ts';
import { createRng } from '../src/shared/core/rng.ts';
import { getBattlefield } from '../src/shared/data/battlefields.ts';
import { getFormation, listFormations } from '../src/shared/data/formations.ts';
import { createSampleBattleUnits } from '../src/shared/data/sample-battle.ts';
import { getStatusDef } from '../src/shared/data/statuses.ts';
import type { BattlePhase, BattleUnit } from '../src/shared/data/types.ts';
import { Battle } from '../src/shared/systems/battle/battle.ts';
import {
  applyDamage,
  createUnit,
  isAlive,
  resolveAttack,
  spFromDamage,
  type DamageSpec,
} from '../src/shared/systems/battle/battle-unit.ts';
import { applyStatus, effectiveStat } from '../src/shared/systems/battle/status-effects.ts';
import { zoneAt } from '../src/shared/systems/battle/terrain.ts';

/** 推进的步长与上限 —— 上限只是防死循环，正常战斗远用不到。 */
const STEP_MS = 250;
const MAX_STEPS = 900;

/** 不带地形的战斗 —— 测的是基本规则，别让地形效果混进来。 */
function makeBattle(seed: number): Battle {
  return new Battle({ units: createSampleBattleUnits().map(createUnit), seed });
}

/** 指定战场的一局。默认摆锋矢阵 —— 阵法决定我方站位。 */
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

/** 推进到有人攒满行动值（或超过步数上限）。 */
async function advanceUntilReady(battle: Battle, maxSteps = 300): Promise<void> {
  for (let step = 0; step < maxSteps && battle.awaitingUnits.length === 0; step += 1) {
    if (battle.finished) return;
    await battle.advance(100);
  }
}

/**
 * 一路自动打到结束。
 *
 * 行动条下没有「提交一整回合」这回事了 —— 改成不断推进时间，谁攒满了就自动出一手。
 * 不挂 director，所以所有演出 await 都被跳过，整场战斗在几毫秒内跑完。
 */
async function runToEnd(battle: Battle): Promise<Battle> {
  battle.start();
  await battle.beginBattle();

  let step = 0;
  while (!battle.finished) {
    step += 1;
    if (step > MAX_STEPS) throw new Error(`推进 ${MAX_STEPS} 步仍未分出胜负`);

    await battle.advance(STEP_MS);
    await battle.autoAct();
  }

  assert.notEqual(battle.phase, 'battle', '结束后不该还停在交战阶段');
  return battle;
}

// ---------------------------------------------------------------------------
// 行动条
// ---------------------------------------------------------------------------

test('同等时间里，速度快的单位攒的行动值更多', async () => {
  const battle = makeBattle(1);
  battle.start();
  await battle.beginBattle();

  // 只推一小段，避免有人已经到点开始行动而清零
  await battle.advance(200);

  const bySpeed = [...battle.units].sort(
    (a, b) => effectiveStat(b, 'spd') - effectiveStat(a, 'spd'),
  );
  const fastest = bySpeed[0];
  const slowest = bySpeed[bySpeed.length - 1];
  assert.ok(fastest && slowest);

  assert.ok(
    fastest.actionGauge > slowest.actionGauge,
    `速度快的应当攒得更快：${fastest.name} ${fastest.actionGauge.toFixed(1)} vs ${slowest.name} ${slowest.actionGauge.toFixed(1)}`,
  );
});

test('只有行动值满了才能下达指令', async () => {
  const battle = makeBattle(2);
  battle.start();
  await battle.beginBattle();

  const actor = battle.units.find((unit) => unit.side === 'ally');
  assert.ok(actor);
  assert.equal(actor.actionGauge, 0, '开局行动值是空的');
  assert.equal(actor.awaitingCommand, false);

  await assert.rejects(
    () => battle.submitAction(actor.id, { actorId: actor.id, commandId: 'attack' }),
    /行动条还没满/,
    '条没满时不该受理指令',
  );
});

test('攒满之后进入待指令，行动完条归零', async () => {
  const battle = makeBattle(3);
  battle.start();
  await battle.beginBattle();

  await advanceUntilReady(battle);

  const actor = battle.awaitingUnits[0];
  assert.ok(actor, '推进够久之后应当有人能动');
  assert.ok(actor.awaitingCommand, '到点的单位应当挂着等待指令');
  assert.ok(actor.actionGauge >= 100, '到点的单位行动值应当是满的');

  await battle.submitAction(actor.id, { actorId: actor.id, commandId: 'defend' });

  assert.equal(actor.awaitingCommand, false, '行动完就该清掉等待标记');
  assert.equal(actor.actionGauge, 0, '行动完行动值归零');
});

test('你在犹豫时，整个战场的时间是停的', async () => {
  const battle = makeBattle(5);
  battle.start();
  await battle.beginBattle();

  await advanceUntilReady(battle);
  const waiting = battle.awaitingUnits[0];
  assert.ok(waiting, '应当有人正等着指令');

  const gaugesBefore = new Map(battle.units.map((unit) => [unit.id, unit.actionGauge]));
  const logBefore = battle.log.length;

  // 挂着指令不下，往里喂 8 秒时间
  await battle.advance(8000);

  // 敌方一步都不许动，全场的条一格都不许涨 —— 这是刻意的，
  // 否则就成了「你还在斟酌，敌人偷跑一轮」。
  assert.equal(battle.log.length, logBefore, '等你下指令时，敌方不该擅自出手');
  for (const unit of battle.units) {
    assert.equal(
      unit.actionGauge,
      gaugesBefore.get(unit.id),
      `${unit.name} 的行动值不该在等待期间变化`,
    );
  }

  assert.ok(battle.awaitingUnits.length > 0, '等着指令的单位应当一直挂着');
});

test('干等着下指令时，它的行动值一直停在满值', async () => {
  const battle = makeBattle(6);
  battle.start();
  await battle.beginBattle();

  await advanceUntilReady(battle);
  const waiting = battle.awaitingUnits[0];
  assert.ok(waiting, '应当有人等着指令');
  assert.equal(waiting.actionGauge, BALANCE.gaugeMax, '到点就该攒满');

  // 干等 4 秒（这段时间敌方照样行动），它的行动值必须一动不动 —— 还没出手呢。
  // 一旦这里松动了，行动条上就会出现「明明满了、却不在行动点上」的鬼影。
  for (let step = 0; step < 40; step += 1) {
    if (battle.finished) break;
    await battle.advance(100);
    assert.equal(
      waiting.actionGauge,
      BALANCE.gaugeMax,
      `等待期间行动值不该变，第 ${step} 步却变成了 ${waiting.actionGauge}`,
    );
  }
});

test('同时到点的多个单位，一次只交给你一个', async () => {
  const battle = makeBattle(4);
  battle.start();
  await battle.beginBattle();

  await advanceUntilReady(battle);

  // 时间既然是停的，就不该一口气冒出好几个待指令的人
  assert.equal(battle.awaitingUnits.length, 1, '一次只该有一个单位等你下指令');

  const first = battle.awaitingUnits[0];
  assert.ok(first, '应当有人等着指令');
  await battle.submitAction(first.id, { actorId: first.id, commandId: 'defend' });

  // 处理掉它，才轮到下一个攒满的人
  await battle.advance(3000);
  const next = battle.awaitingUnits[0];
  assert.ok(next, '还有别人攒满了，应当接着轮到他');
  assert.notEqual(next.id, first.id, '不该还是刚出手的那个人');
});

// ---------------------------------------------------------------------------
// 基本规则
// ---------------------------------------------------------------------------

test('同一套数据能打完一场完整战斗，且我方整体占优', async () => {
  const outcomes = new Map<string, number>();

  for (let seed = 1; seed <= 30; seed += 1) {
    const battle = await runToEnd(makeBattle(seed));
    const outcome = battle.result?.outcome ?? 'none';
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);

    assert.ok(battle.log.length > 10, `seed=${seed} 的日志过少，可能没真的打起来`);
  }

  const wins = outcomes.get('victory') ?? 0;
  assert.ok(
    wins >= 24,
    `30 场里只赢了 ${wins} 场，数值可能失衡：${JSON.stringify([...outcomes])}`,
  );
});

test('开战进入交战阶段，结束时进入终局阶段', async () => {
  const battle = makeBattle(7);
  battle.start();
  assert.equal(battle.phase, 'deployment', '开局停在布阵阶段');

  const phases: BattlePhase[] = [];
  battle.events.on('phase', (phase) => phases.push(phase));

  await battle.beginBattle();
  assert.equal(battle.phase, 'battle', '开战后进入交战');

  for (let step = 0; step < MAX_STEPS && !battle.finished; step += 1) {
    await battle.advance(STEP_MS);
    await battle.autoAct();
  }

  assert.ok(battle.finished, '应当能分出胜负');
  assert.ok(
    phases.some((phase) => phase === 'victory' || phase === 'defeat' || phase === 'fled'),
    `终局阶段应当被广播出来：${phases.join(' → ')}`,
  );
});

test('HP / MP / SP 全程不越界', async () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const battle = await runToEnd(makeBattle(seed));

    for (const unit of battle.units) {
      const { hp, maxHp, mp, maxMp, sp, maxSp } = unit.stats;
      assert.ok(hp >= 0 && hp <= maxHp, `${unit.name} 的 HP 越界：${hp}/${maxHp}`);
      assert.ok(mp >= 0 && mp <= maxMp, `${unit.name} 的 MP 越界：${mp}/${maxMp}`);
      assert.ok(sp >= 0 && sp <= maxSp, `${unit.name} 的 SP 越界：${sp}/${maxSp}`);
      assert.ok(
        unit.actionGauge >= 0 && unit.actionGauge <= 100,
        `${unit.name} 的行动值越界：${unit.actionGauge}`,
      );
    }
  }
});

test('状态效果到期后会被移除', async () => {
  const battle = makeBattle(3);
  battle.start();
  await battle.beginBattle();

  const boss = battle.units.find((unit) => unit.id === 'enemy.chieftain');
  assert.ok(boss, '找不到山魈首领');

  applyStatus(boss, getStatusDef('poison'), 'test', 1);
  assert.equal(boss.statuses.length, 1);

  for (let step = 0; step < MAX_STEPS && boss.statuses.length > 0; step += 1) {
    if (battle.finished) break;
    await battle.advance(STEP_MS);
    await battle.autoAct();
  }

  assert.ok(
    !boss.statuses.some((status) => status.def.id === 'poison'),
    '只持续 1 轮的中毒应当已经被移除',
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

test('防御一直撑到下次行动点，中途挨打都是减半的', async () => {
  const battle = makeBattle(8);
  battle.start();
  await battle.beginBattle();

  await advanceUntilReady(battle);
  const guard = battle.awaitingUnits[0];
  assert.ok(guard, '应当有人能动');

  await battle.submitAction(guard.id, { actorId: guard.id, commandId: 'defend' });
  assert.equal(guard.isDefending, true, '摆完防御就该是防御姿态');

  // 一路推到它下次条满 —— 这中间敌人打它都得是减半的，
  // 所以姿态一松就是 bug（之前正是在行动收尾时被清掉的）。
  // 注意：队友也在等指令，得替他们下掉，否则全场会一直冻结着推不动。
  let reachedNextPoint = false;
  for (let step = 0; step < 800; step += 1) {
    if (battle.finished) break;

    await battle.advance(100);

    if (guard.actionGauge >= BALANCE.gaugeMax) {
      reachedNextPoint = true;
      break;
    }

    assert.equal(
      guard.isDefending,
      true,
      `还没到下次行动点（第 ${step} 步，条 ${guard.actionGauge.toFixed(1)}），防御不该解除`,
    );

    for (let i = 0; i < 5; i += 1) {
      const other = battle.awaitingUnits.find((unit) => unit.id !== guard.id);
      if (!other) break;
      await battle.submitAction(other.id, { actorId: other.id, commandId: 'defend' });
    }
  }

  assert.ok(reachedNextPoint, '推了这么久，它总该攒到下一格');
  assert.equal(guard.isDefending, false, '到了下次行动点，防御姿态就该到期');
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

test('愤怒表：每一档都对得上', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [5, 5],
    [9, 9],
    [10, 10],
    [19, 10],
    [20, 15],
    [29, 15],
    [30, 25],
    [49, 25],
    [50, 40],
    [79, 40],
    [80, 55],
    [100, 55],
  ];

  for (const [percent, expected] of cases) {
    assert.equal(spFromDamage(percent), expected, `掉 ${percent}% 血该给 ${expected} 愤怒`);
  }
});

test('愤怒看的是「被削掉几成血」，跟伤害绝对值无关', () => {
  const frail = createUnit({
    id: 'test.frail',
    name: '脆皮',
    side: 'ally',
    stats: { maxHp: 100, maxMp: 0, maxSp: 100, sp: 0, def: 0, res: 0, spd: 10 },
  });
  const tanky = createUnit({
    id: 'test.tanky',
    name: '肉盾',
    side: 'ally',
    stats: { maxHp: 1000, maxMp: 0, maxSp: 100, sp: 0, def: 0, res: 0, spd: 10 },
  });

  // 两边都掉了「一成血」：一个挨 10 点，一个挨 100 点
  const a = applyDamage(frail, 10);
  const b = applyDamage(tanky, 100);

  assert.equal(a.spGained, 10, '掉一成血给 10 愤怒');
  assert.equal(
    b.spGained,
    a.spGained,
    `掉同样的比例就该给同样的愤怒（实际 ${a.spGained} vs ${b.spGained}）—— 否则肉盾永远攒不出特技`,
  );

  // 挨得越狠，涨得越多
  const c = applyDamage(tanky, 250); // 25% → 15
  assert.equal(c.spGained, 15, '掉两成半给 15 愤怒');
});

test('逃跑成功会立即结束战斗', async () => {
  let fled = false;

  for (let seed = 1; seed <= 60 && !fled; seed += 1) {
    const battle = makeBattle(seed);
    battle.start();
    await battle.beginBattle();

    await advanceUntilReady(battle);
    const actor = battle.awaitingUnits[0];
    assert.ok(actor, '推进后应当有可操作的我方单位');

    await battle.submitAction(actor.id, { actorId: actor.id, commandId: 'flee' });
    if (battle.result?.outcome === 'fled') fled = true;
  }

  assert.ok(fled, '60 个种子都没能逃跑成功，逃跑概率可能算错了');
});

test('挂了 director 时，演出点会被依次回调', async () => {
  const battle = makeBattle(11);
  const calls: string[] = [];

  battle.director = {
    onRoundStart: () => {
      calls.push('roundStart');
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

  for (let step = 0; step < MAX_STEPS && !calls.some((c) => c.startsWith('after:')); step += 1) {
    if (battle.finished) break;
    await battle.advance(STEP_MS);
    await battle.autoAct();
  }

  assert.ok(calls.some((call) => call.startsWith('before:')), '至少应当有一次行动前摇');
  assert.ok(calls.includes('strike'), '行动期间应当有伤害回调');

  // 每个 before 都要配一个同名的 after，否则演出层会漏归位
  const befores = calls.filter((call) => call.startsWith('before:')).map((c) => c.slice(7));
  const afters = calls.filter((call) => call.startsWith('after:')).map((c) => c.slice(6));
  assert.deepEqual(afters, befores, 'beforeAction 与 afterAction 必须成对');
});

// ---------------------------------------------------------------------------
// 道具
// ---------------------------------------------------------------------------

/** 造一个「轮到某人行动」的局面，好在上面试道具。 */
async function readyBattle(seed: number): Promise<{ battle: Battle; actor: BattleUnit }> {
  const battle = makeBattle(seed);
  battle.start();
  await battle.beginBattle();
  await advanceUntilReady(battle);

  const actor = battle.awaitingUnits[0];
  assert.ok(actor, '应当有人轮到行动');
  return { battle, actor };
}

test('回复类道具：按口径回血，并扣掉一件', async () => {
  const { battle, actor } = await readyBattle(12);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  assert.ok(ally, '需要一个队友当目标');
  ally.stats.hp = 10;

  const before = battle.partyItems.find((stack) => stack.itemId === 'hpSalve')?.count ?? 0;
  assert.ok(before > 0, '开局应当带了几瓶金创药');

  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: 'hpSalve',
    targetId: ally.id,
  });

  assert.equal(ally.stats.hp, 90, '金创药固定回 80 点');
  assert.equal(
    battle.partyItems.find((stack) => stack.itemId === 'hpSalve')?.count,
    before - 1,
    '用掉一件就该少一件',
  );
});

test('比例回复与全满回复各按各的口径', async () => {
  const { battle, actor } = await readyBattle(13);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  assert.ok(ally);

  ally.stats.hp = 10;
  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: 'hpPaste',
    targetId: ally.id,
  });
  assert.equal(ally.stats.hp, 10 + Math.round(ally.stats.maxHp * 0.35), '生肌膏按上限的 35% 回');

  ally.stats.hp = 1;
  await battle.advance(6000);
  const actor2 = battle.awaitingUnits[0];
  if (actor2) {
    await battle.submitAction(actor2.id, {
      actorId: actor2.id,
      commandId: 'useItem',
      itemId: 'hpElixir',
      targetId: ally.id,
    });
    assert.equal(ally.stats.hp, ally.stats.maxHp, '大还丹直接回满');
  }
});

test('解除类道具：只解该解的，增益不动', async () => {
  const { battle, actor } = await readyBattle(14);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  assert.ok(ally);

  applyStatus(ally, getStatusDef('poison'), 'test', 3);
  applyStatus(ally, getStatusDef('burn'), 'test', 3);
  applyStatus(ally, getStatusDef('atkUp'), 'test', 3);

  // 解毒散只解中毒
  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: 'cureOne',
    targetId: ally.id,
  });

  assert.ok(!ally.statuses.some((s) => s.def.id === 'poison'), '中毒该被解掉');
  assert.ok(ally.statuses.some((s) => s.def.id === 'burn'), '灼烧不在解毒散的范围内');
  assert.ok(ally.statuses.some((s) => s.def.id === 'atkUp'), '增益绝不该被「解」');
});

test('还魂香：清掉全部异常，但增益留着', async () => {
  const { battle, actor } = await readyBattle(15);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  assert.ok(ally);

  applyStatus(ally, getStatusDef('poison'), 'test', 3);
  applyStatus(ally, getStatusDef('burn'), 'test', 3);
  applyStatus(ally, getStatusDef('stun'), 'test', 3);
  applyStatus(ally, getStatusDef('defUp'), 'test', 3);

  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: 'cureAll',
    targetId: ally.id,
  });

  assert.deepEqual(
    ally.statuses.map((s) => s.def.id),
    ['defUp'],
    '异常该全清，增益该原样留着',
  );
});

test('增益类道具：给目标挂上对应的状态', async () => {
  const { battle, actor } = await readyBattle(16);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  assert.ok(ally);

  const before = effectiveStat(ally, 'spd');

  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: 'spdPill',
    targetId: ally.id,
  });

  assert.ok(ally.statuses.some((s) => s.def.id === 'spdUp'), '疾风丹该挂上疾风');
  assert.ok(effectiveStat(ally, 'spd') > before, '速度该真的涨上去');
});

test('道具只能对自己人用，对敌人用不出去', async () => {
  const { battle, actor } = await readyBattle(17);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  const foe = battle.units.find((unit) => unit.side === 'enemy');
  assert.ok(ally && foe);

  ally.stats.hp = 10;
  foe.stats.hp = 100;

  const beforeCount = battle.partyItems.find((s) => s.itemId === 'hpSalve')?.count ?? 0;

  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: 'hpSalve',
    targetId: foe.id,
  });

  assert.equal(foe.stats.hp, 100, '敌人的血不该被治');
  assert.equal(
    battle.partyItems.find((s) => s.itemId === 'hpSalve')?.count,
    beforeCount,
    '没生效就不该消耗',
  );
});

test('背包里没有的道具用不出去', async () => {
  const { battle, actor } = await readyBattle(18);

  const ally = battle.units.find((unit) => unit.side === 'ally' && unit.id !== actor.id);
  assert.ok(ally);

  const before = ally.stats.hp;
  await battle.submitAction(actor.id, {
    actorId: actor.id,
    commandId: 'useItem',
    itemId: '不存在的药',
    targetId: ally.id,
  });

  assert.equal(ally.stats.hp, before, '什么都没发生');
  assert.ok(
    battle.log.some((entry) => entry.text.includes('背包里已经没有这一件')),
    '该在日志里说明白',
  );
});

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

test('走出地形区域后，地形状态会在下一轮被清除', async () => {
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

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (battle.finished) break;
    if (!target.statuses.some((status) => status.def.id === 'frostbite')) break;
    await battle.advance(STEP_MS);
    await battle.autoAct();
  }

  assert.ok(
    !target.statuses.some((status) => status.def.id === 'frostbite'),
    '离开区域后冻伤应当消退',
  );
});

test('三个战场都能打完一整场', async () => {
  for (const id of ['snow-ridge', 'flame-rift', 'immortal-spring']) {
    const battle = await runToEnd(makeBattleOn(id, 9));
    assert.ok(battle.result, `战场 ${id} 没能分出胜负`);
  }
});
