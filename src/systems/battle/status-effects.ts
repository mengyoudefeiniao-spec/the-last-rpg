import type {
  ActiveStatus,
  BattleUnit,
  StatKey,
  StatusDef,
  StatusPowerMode,
  StatusTrigger,
} from '../../data/types.ts';

/**
 * 状态效果库。
 * 约定：同名状态只存在一份，再次施加是「刷新持续时间」而不是叠加 —— 避免数值滚雪球。
 */
const STATUS_DEFS = {
  // ---------- 减益 ----------
  poison: {
    id: 'poison',
    name: '中毒',
    kind: 'debuff',
    duration: 3,
    dot: { label: '中毒', power: 0.06, mode: 'percentMaxHp' },
    trigger: 'actionEnd',
    desc: '每回合结束损失 6% 最大生命',
  },
  burn: {
    id: 'burn',
    name: '灼烧',
    kind: 'debuff',
    duration: 2,
    dot: { label: '灼烧', power: 22, mode: 'flat' },
    trigger: 'actionEnd',
    desc: '每回合结束受到固定火焰伤害',
  },
  defDown: {
    id: 'defDown',
    name: '破甲',
    kind: 'debuff',
    duration: 3,
    modifiers: { def: -0.3 },
    trigger: 'turnStart',
    desc: '防御力 -30%',
  },
  spdDown: {
    id: 'spdDown',
    name: '迟滞',
    kind: 'debuff',
    duration: 2,
    modifiers: { spd: -0.3 },
    trigger: 'turnStart',
    desc: '速度 -30%',
  },
  stun: {
    id: 'stun',
    name: '眩晕',
    kind: 'debuff',
    duration: 1,
    skipAction: true,
    trigger: 'turnStart',
    desc: '本回合无法行动',
  },

  // ---------- 增益 ----------
  atkUp: {
    id: 'atkUp',
    name: '攻击强化',
    kind: 'buff',
    duration: 3,
    modifiers: { atk: 0.3 },
    trigger: 'turnStart',
    desc: '攻击力 +30%',
  },
  defUp: {
    id: 'defUp',
    name: '铁壁',
    kind: 'buff',
    duration: 3,
    modifiers: { def: 0.5 },
    trigger: 'turnStart',
    desc: '防御力 +50%',
  },
  magUp: {
    id: 'magUp',
    name: '法力涌动',
    kind: 'buff',
    duration: 3,
    modifiers: { mag: 0.35 },
    trigger: 'turnStart',
    desc: '法术强度 +35%',
  },
  spdUp: {
    id: 'spdUp',
    name: '疾风',
    kind: 'buff',
    duration: 3,
    modifiers: { spd: 0.4 },
    trigger: 'turnStart',
    desc: '速度 +40%',
  },
  regen: {
    id: 'regen',
    name: '回春',
    kind: 'buff',
    duration: 3,
    hot: { label: '回春', power: 0.08, mode: 'percentMaxHp' },
    trigger: 'actionEnd',
    desc: '每回合结束回复 8% 最大生命',
  },
  rage: {
    id: 'rage',
    name: '狂怒',
    kind: 'buff',
    duration: 3,
    modifiers: { atk: 0.2 },
    spGainBonus: 0.5,
    trigger: 'turnStart',
    desc: '攻击力 +20%，受击时愤怒获取 +50%',
  },
} satisfies Record<string, StatusDef>;

export type StatusId = keyof typeof STATUS_DEFS;

export function getStatusDef(id: StatusId): StatusDef {
  return STATUS_DEFS[id];
}

/**
 * 属性修正后的有效值。
 * 修正按「倍率相加」计算：同时有 +30% 和 +20% 时是 ×1.5，而不是 ×1.3×1.2。
 */
export function effectiveStat(unit: BattleUnit, key: StatKey): number {
  let multiplier = 1;
  for (const status of unit.statuses) {
    const modifier = status.def.modifiers?.[key];
    if (modifier !== undefined) multiplier += modifier;
  }
  return Math.max(0, Math.round(unit.stats[key] * multiplier));
}

/** 施加状态；已存在同名状态则刷新持续时间。返回 true 表示这是一次刷新。 */
export function applyStatus(
  unit: BattleUnit,
  def: StatusDef,
  sourceId: string,
  duration?: number,
): boolean {
  const remaining = duration ?? def.duration;
  const existing = unit.statuses.find((status) => status.def.id === def.id);
  if (existing) {
    existing.remaining = Math.max(existing.remaining, remaining);
    existing.sourceId = sourceId;
    return true;
  }
  unit.statuses.push({ uid: `${unit.id}::${def.id}`, def, remaining, sourceId });
  return false;
}

/** 该单位是否被状态禁止行动。返回罪魁祸首，便于记日志。 */
export function blockingStatus(unit: BattleUnit): ActiveStatus | undefined {
  return unit.statuses.find((status) => status.def.skipAction === true);
}

export interface StatusTick {
  status: ActiveStatus;
  effect: 'damage' | 'heal';
  amount: number;
  label: string;
}

/**
 * 收集某阶段应当结算的状态效果。
 * 只做计算、不改单位 —— 由 Battle 负责应用，方便单测和日志排序。
 */
export function collectStatusTicks(unit: BattleUnit, trigger: StatusTrigger): StatusTick[] {
  const ticks: StatusTick[] = [];
  for (const status of unit.statuses) {
    if (status.def.trigger !== trigger) continue;
    const dot = status.def.dot;
    const hot = status.def.hot;
    if (dot) {
      ticks.push({ status, effect: 'damage', amount: resolvePower(dot, unit), label: dot.label });
    }
    if (hot) {
      ticks.push({ status, effect: 'heal', amount: resolvePower(hot, unit), label: hot.label });
    }
  }
  return ticks;
}

function resolvePower(
  spec: { power: number; mode: StatusPowerMode },
  unit: BattleUnit,
): number {
  return spec.mode === 'flat' ? spec.power : Math.round(unit.stats.maxHp * spec.power);
}

/** 所有状态剩余回合 -1，返回因此到期的状态。 */
export function decrementDurations(unit: BattleUnit): ActiveStatus[] {
  const expired: ActiveStatus[] = [];
  for (const status of unit.statuses) {
    status.remaining -= 1;
    if (status.remaining <= 0) expired.push(status);
  }
  if (expired.length > 0) {
    unit.statuses = unit.statuses.filter((status) => status.remaining > 0);
  }
  return expired;
}
