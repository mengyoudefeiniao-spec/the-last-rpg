import { BALANCE } from '../../config/balance.ts';
import type { BattleUnit, PendingAction } from '../../data/types.ts';
import type { Rng } from '../../core/rng.ts';
import { enemiesOf } from './battle-unit.ts';
import { checkUsable, getCommand } from './commands.ts';

/**
 * 敌人 AI 与自动战斗决策。
 * 只接收「单位数组 + rng」，不依赖 Battle 类 —— 依赖保持单向，且这两条决策可以单独测。
 */

/** 敌人行动决策：血量告急且愤怒够就放特技，法系优先法术，否则普攻。 */
export function chooseEnemyAction(
  unit: BattleUnit,
  units: readonly BattleUnit[],
  rng: Rng,
): PendingAction {
  const targets = enemiesOf(units, unit);
  if (targets.length === 0) return { actorId: unit.id, commandId: 'defend' };

  const skill = getCommand('skill');
  const spell = getCommand('spell');
  const hpRatio = unit.stats.hp / unit.stats.maxHp;

  if (hpRatio < BALANCE.aiSkillHpThreshold && unit.stats.sp >= (skill.cost.sp ?? 0)) {
    return { actorId: unit.id, commandId: 'skill', targetId: pickFocus(targets, rng).id };
  }

  if (unit.stats.mag > unit.stats.atk && unit.stats.mp >= (spell.cost.mp ?? 0)) {
    return { actorId: unit.id, commandId: 'spell', targetId: pickFocus(targets, rng).id };
  }

  return { actorId: unit.id, commandId: 'attack', targetId: rng.pick(targets).id };
}

/**
 * 自动战斗决策：**像玩家那样打**，而不是乱按。
 *
 * 这里原本是「从可用指令里随机挑一条」，结果真测出一个问题：物攻型的阿蛮会反复用
 * 魔法类的「灵宝」去打高法抗的尸傀，每次只蹭掉 2 点血，战斗永远磨不完。
 * 自动战斗代表着「一个普通玩家」，所以按属性选招才对。
 *
 * 仍然排除「逃跑」—— 否则永远测不出胜负。
 */
export function chooseAutoAllyAction(
  unit: BattleUnit,
  units: readonly BattleUnit[],
  rng: Rng,
): PendingAction {
  const targets = enemiesOf(units, unit);
  if (targets.length === 0) return { actorId: unit.id, commandId: 'defend' };

  const target = pickFocus(targets, rng);

  // 愤怒够就放特技 —— 伤害最高
  if (checkUsable(unit, getCommand('skill')).ok) {
    return { actorId: unit.id, commandId: 'skill', targetId: target.id };
  }

  // 法系优先法术
  if (unit.stats.mag > unit.stats.atk && checkUsable(unit, getCommand('spell')).ok) {
    return { actorId: unit.id, commandId: 'spell', targetId: target.id };
  }

  return { actorId: unit.id, commandId: 'attack', targetId: target.id };
}

/** 七成概率集火最虚弱的敌人，偶尔随机 —— 免得 AI 行为过于机械。 */
function pickFocus(targets: readonly BattleUnit[], rng: Rng): BattleUnit {
  if (!rng.chance(0.7)) return rng.pick(targets);
  return targets.reduce((weakest, foe) => (foe.stats.hp < weakest.stats.hp ? foe : weakest));
}
