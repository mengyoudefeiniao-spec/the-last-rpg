import type {
  ActiveStatus,
  BattleUnit,
  StatKey,
  StatusDef,
  StatusPowerMode,
  StatusTrigger,
} from '../../data/types.ts';

/**
 * 状态效果的运行时逻辑。
 * 状态表本身（有哪些状态、数值多少）在 data/statuses.ts —— 那是数据，这里是逻辑。
 */

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

/** 移除指定状态。返回是否真的移除掉了。 */
export function removeStatus(unit: BattleUnit, statusId: string): boolean {
  const before = unit.statuses.length;
  unit.statuses = unit.statuses.filter((status) => status.def.id !== statusId);
  return unit.statuses.length !== before;
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
