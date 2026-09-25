import type { BattleUnit, CommandDef, CommandId } from '../../data/types.ts';

/**
 * 九种指令的定义。
 * 原型阶段数值内联在此，将来搬到 data/commands/ 由数据驱动（见 data/README.md）。
 *
 * 标记 placeholder 的四条（法宝 / 灵宝 / 召唤 / 捕捉）目前是占位实现：
 * 资源消耗与日志齐全，但效果是简化的统一逻辑，等待各自的真实设计。
 */
const COMMAND_DEFS = {
  attack: {
    id: 'attack',
    label: '普通攻击',
    desc: '基础物理攻击，不消耗资源。',
    requiresTarget: true,
    cost: {},
    resolvesImmediately: false,
  },
  spell: {
    id: 'spell',
    label: '法术',
    desc: '消耗 12 MP，造成魔法伤害，有几率附加灼烧。',
    requiresTarget: true,
    cost: { mp: 12 },
    resolvesImmediately: false,
  },
  skill: {
    id: 'skill',
    label: '特技',
    desc: '消耗 30 愤怒，造成高额物理伤害并附加破甲。',
    requiresTarget: true,
    cost: { sp: 30 },
    resolvesImmediately: false,
  },
  talisman: {
    id: 'talisman',
    label: '法宝',
    desc: '【占位】祭出法宝，造成物理伤害。',
    requiresTarget: true,
    cost: { mp: 10 },
    resolvesImmediately: false,
    placeholder: true,
  },
  spiritTreasure: {
    id: 'spiritTreasure',
    label: '灵宝',
    desc: '【占位】祭出灵宝，对敌方全体造成魔法伤害。',
    requiresTarget: false,
    cost: { sp: 25 },
    resolvesImmediately: false,
    placeholder: true,
  },
  summon: {
    id: 'summon',
    label: '召唤',
    desc: '【占位】召唤灵兽，对敌方全体造成伤害。',
    requiresTarget: false,
    cost: { mp: 20 },
    resolvesImmediately: false,
    placeholder: true,
  },
  capture: {
    id: 'capture',
    label: '捕捉',
    desc: '【占位】尝试捕捉目标，目标血量越低成功率越高。',
    requiresTarget: true,
    cost: { mp: 8 },
    resolvesImmediately: false,
    placeholder: true,
  },
  defend: {
    id: 'defend',
    label: '防御',
    desc: '本回合减伤 50%，并获得额外愤怒。',
    requiresTarget: false,
    selfOnly: true,
    cost: {},
    resolvesImmediately: true,
  },
  flee: {
    id: 'flee',
    label: '逃跑',
    desc: '尝试脱离战斗，失败会白挨一轮。',
    requiresTarget: false,
    cost: {},
    resolvesImmediately: true,
  },
} satisfies Record<CommandId, CommandDef>;

export function getCommand(id: CommandId): CommandDef {
  return COMMAND_DEFS[id];
}

/** UI 按此顺序排列指令按钮。 */
export const COMMAND_ORDER: readonly CommandId[] = [
  'attack',
  'spell',
  'skill',
  'talisman',
  'spiritTreasure',
  'summon',
  'capture',
  'defend',
  'flee',
];

/** 资源是否够用。 */
export function canAfford(unit: BattleUnit, def: CommandDef): boolean {
  if (def.cost.mp !== undefined && unit.stats.mp < def.cost.mp) return false;
  if (def.cost.sp !== undefined && unit.stats.sp < def.cost.sp) return false;
  return true;
}

/** 指令能否使用，附带原因 —— UI 用它把按钮置灰并给出 tooltip。 */
export function checkUsable(unit: BattleUnit, def: CommandDef): { ok: boolean; reason?: string } {
  if (def.cost.mp !== undefined && unit.stats.mp < def.cost.mp) {
    return { ok: false, reason: `MP 不足（需要 ${def.cost.mp}）` };
  }
  if (def.cost.sp !== undefined && unit.stats.sp < def.cost.sp) {
    return { ok: false, reason: `愤怒不足（需要 ${def.cost.sp}）` };
  }
  if (unit.statuses.some((status) => status.def.skipAction === true)) {
    return { ok: false, reason: '本回合无法行动' };
  }
  return { ok: true };
}
