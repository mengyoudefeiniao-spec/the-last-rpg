import { BALANCE } from '../../config/balance.ts';
import type { BattleUnit, PendingAction } from '../../data/types.ts';
import type { Rng } from '../../core/rng.ts';
import { enemiesOf } from './battle-unit.ts';
import { COMMAND_ORDER, checkUsable, getCommand } from './commands.ts';

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
 * 演示与测试用：为玩家单位随机挑一条当前可用的指令。
 * 排除「逃跑」—— 否则自动战斗可能永远打不完，测不出胜负。
 */
export function chooseAutoAllyAction(
  unit: BattleUnit,
  units: readonly BattleUnit[],
  rng: Rng,
): PendingAction {
  const targets = enemiesOf(units, unit);
  if (targets.length === 0) return { actorId: unit.id, commandId: 'defend' };

  const usable = COMMAND_ORDER.filter((id) => {
    if (id === 'flee') return false;
    return checkUsable(unit, getCommand(id)).ok;
  });

  const commandId = rng.pick(usable);
  const def = getCommand(commandId);
  if (!def.requiresTarget) return { actorId: unit.id, commandId };

  return { actorId: unit.id, commandId, targetId: rng.pick(targets).id };
}

/** 七成概率集火最虚弱的敌人，偶尔随机 —— 免得 AI 行为过于机械。 */
function pickFocus(targets: readonly BattleUnit[], rng: Rng): BattleUnit {
  if (!rng.chance(0.7)) return rng.pick(targets);
  return targets.reduce((weakest, foe) => (foe.stats.hp < weakest.stats.hp ? foe : weakest));
}
