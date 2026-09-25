import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRng } from '../src/core/rng.ts';
import { createSampleBattleUnits } from '../src/data/sample-battle.ts';
import type { BattlePhase } from '../src/data/types.ts';
import { Battle } from '../src/systems/battle/battle.ts';
import {
  createUnit,
  resolveAttack,
  type DamageSpec,
} from '../src/systems/battle/battle-unit.ts';
import { applyStatus, getStatusDef } from '../src/systems/battle/status-effects.ts';

const MAX_TURNS = 200;

function makeBattle(seed: number): Battle {
  return new Battle({ units: createSampleBattleUnits().map(createUnit), seed });
}

/** 一路自动打到结束。顺带校验：只要没结束，就一定停在指令阶段等输入。 */
function runToEnd(battle: Battle): Battle {
  battle.start();
  let guard = 0;

  while (!battle.finished) {
    assert.equal(battle.phase, 'commandInput', '战斗未结束时应当停在指令阶段等待输入');
    guard += 1;
    if (guard > MAX_TURNS) throw new Error(`超过 ${MAX_TURNS} 回合仍未分出胜负`);

    battle.submit(battle.autoCommand());
  }

  assert.notEqual(battle.phase, 'commandInput', '结束后不应停留在指令阶段');
  return battle;
}

test('同一套数据能打完一场完整战斗，且我方整体占优', () => {
  const outcomes = new Map<string, number>();

  for (let seed = 1; seed <= 30; seed += 1) {
    const battle = runToEnd(makeBattle(seed));
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

test('一个回合内的阶段顺序与设计一致', () => {
  const battle = makeBattle(7);
  const phases: BattlePhase[] = [];
  battle.events.on('phase', (phase) => phases.push(phase));

  battle.start();
  phases.length = 0; // 只关心一个完整回合的循环

  battle.submit(battle.autoCommand());

  assert.deepEqual(phases, [
    'statusSettlement',
    'executeCommands',
    'bothSidesAction',
    'actionEnd',
    'turnStart',
    'commandInput',
  ]);
});

test('HP / MP / SP 全程不越界', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const battle = runToEnd(makeBattle(seed));

    for (const unit of battle.units) {
      const { hp, maxHp, mp, maxMp, sp, maxSp } = unit.stats;
      assert.ok(hp >= 0 && hp <= maxHp, `${unit.name} 的 HP 越界：${hp}/${maxHp}`);
      assert.ok(mp >= 0 && mp <= maxMp, `${unit.name} 的 MP 越界：${mp}/${maxMp}`);
      assert.ok(sp >= 0 && sp <= maxSp, `${unit.name} 的 SP 越界：${sp}/${maxSp}`);
    }
  }
});

test('状态效果到期后会在行动结束判定阶段被移除', () => {
  const battle = makeBattle(3);
  battle.start();

  const boss = battle.units.find((unit) => unit.id === 'enemy.chieftain');
  assert.ok(boss, '找不到山魈首领');

  applyStatus(boss, getStatusDef('poison'), 'test', 1);
  assert.equal(boss.statuses.length, 1);

  battle.submit(battle.autoCommand());

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

test('逃跑成功会立即结束战斗', () => {
  let fled = false;

  for (let seed = 1; seed <= 60 && !fled; seed += 1) {
    const battle = makeBattle(seed);
    battle.start();

    const actor = battle.awaitingUnits[0];
    assert.ok(actor, '首个回合应当有可操作的我方单位');

    battle.submit([{ actorId: actor.id, commandId: 'flee' }]);
    if (battle.result?.outcome === 'fled') fled = true;
  }

  assert.ok(fled, '60 个种子都没能逃跑成功，逃跑概率可能算错了');
});
