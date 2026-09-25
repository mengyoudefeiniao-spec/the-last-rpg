import { BALANCE } from '../../config/balance.ts';
import type { BattleUnit, BattleUnitInit, DamageKind, Stats } from '../../data/types.ts';
import type { Rng } from '../../core/rng.ts';
import { applyStatus, effectiveStat } from './status-effects.ts';

/** 由输入构造战斗单位，未提供的当前值默认回满。 */
export function createUnit(init: BattleUnitInit): BattleUnit {
  const unit: BattleUnit = {
    id: init.id,
    name: init.name,
    side: init.side,
    stats: createStats(init.stats),
    statuses: [],
    position: init.position ? { ...init.position } : { x: 0, z: 0 },
    isDefending: false,
    hasActed: false,
    captured: false,
    isPlayerControlled: init.isPlayerControlled ?? init.side === 'ally',
  };
  for (const def of init.statuses ?? []) {
    applyStatus(unit, def, 'system');
  }
  return unit;
}

function createStats(init: BattleUnitInit['stats']): Stats {
  return {
    maxHp: init.maxHp,
    hp: init.hp ?? init.maxHp,
    maxMp: init.maxMp,
    mp: init.mp ?? init.maxMp,
    maxSp: init.maxSp,
    sp: init.sp ?? 0,
    atk: init.atk ?? 10,
    def: init.def ?? 5,
    mag: init.mag ?? 10,
    res: init.res ?? 5,
    spd: init.spd ?? 10,
  };
}

export function isAlive(unit: BattleUnit): boolean {
  return unit.stats.hp > 0 && !unit.captured;
}

/** 与 unit 敌对且存活的所有单位。 */
export function enemiesOf(units: readonly BattleUnit[], unit: BattleUnit): BattleUnit[] {
  return units.filter((other) => other.side !== unit.side && isAlive(other));
}

/** 与 unit 同阵营且存活的单位（不含自己）。 */
export function alliesOf(units: readonly BattleUnit[], unit: BattleUnit): BattleUnit[] {
  return units.filter(
    (other) => other.id !== unit.id && other.side === unit.side && isAlive(other),
  );
}

// ---------------------------------------------------------------------------
// HP / MP / SP
// ---------------------------------------------------------------------------

export function healHp(unit: BattleUnit, amount: number): number {
  const before = unit.stats.hp;
  unit.stats.hp = clamp(unit.stats.hp + Math.round(amount), 0, unit.stats.maxHp);
  return unit.stats.hp - before;
}

export function gainMp(unit: BattleUnit, amount: number): number {
  const before = unit.stats.mp;
  unit.stats.mp = clamp(unit.stats.mp + Math.round(amount), 0, unit.stats.maxMp);
  return unit.stats.mp - before;
}

/** SP = 愤怒，受击积攒、释放特技消耗。 */
export function gainSp(unit: BattleUnit, amount: number): number {
  const before = unit.stats.sp;
  unit.stats.sp = clamp(unit.stats.sp + Math.round(amount), 0, unit.stats.maxSp);
  return unit.stats.sp - before;
}

/** 尝试扣除 MP，资源不足时返回 false 且不扣。 */
export function spendMp(unit: BattleUnit, amount: number): boolean {
  if (unit.stats.mp < amount) return false;
  unit.stats.mp -= amount;
  return true;
}

/** 尝试扣除 SP，资源不足时返回 false 且不扣。 */
export function spendSp(unit: BattleUnit, amount: number): boolean {
  if (unit.stats.sp < amount) return false;
  unit.stats.sp -= amount;
  return true;
}

// ---------------------------------------------------------------------------
// 伤害结算
// ---------------------------------------------------------------------------

export interface DamageSpec {
  kind: DamageKind;
  /** 威力倍率，1 表示标准强度。 */
  mult: number;
  /** 是否可暴击（仅物理有意义）。 */
  canCrit?: boolean;
  label: string;
}

export interface DamageOutcome {
  /** 实际扣除的生命值。 */
  dealt: number;
  crit: boolean;
  defeated: boolean;
  /** 受击方因此获得的 SP。 */
  spGained: number;
}

/**
 * 伤害公式：攻方有效攻击 × 倍率 − 守方有效防御 × 抵消系数，
 * 再乘随机浮动、暴击、防御姿态减伤，最后取下限。
 */
export function resolveAttack(
  attacker: BattleUnit,
  defender: BattleUnit,
  spec: DamageSpec,
  rng: Rng,
): DamageOutcome {
  const offense =
    spec.kind === 'physical' ? effectiveStat(attacker, 'atk') : effectiveStat(attacker, 'mag');
  const defense =
    spec.kind === 'physical' ? effectiveStat(defender, 'def') : effectiveStat(defender, 'res');
  const mitigation = defense * (spec.kind === 'physical' ? BALANCE.defFactor : BALANCE.resFactor);

  let raw = offense * spec.mult - mitigation;
  raw = Math.max(BALANCE.minDamage, raw);

  const variance = 1 + (rng.next() * 2 - 1) * BALANCE.damageVariance;
  raw *= variance;

  const crit =
    spec.kind === 'physical' && spec.canCrit === true && rng.chance(BALANCE.critChance);
  if (crit) raw *= BALANCE.critMultiplier;

  if (defender.isDefending) raw *= 1 - BALANCE.defendReduction;

  return applyDamage(defender, Math.max(BALANCE.minDamage, Math.round(raw)), crit);
}

/** 直接扣血并结算「受击获得愤怒」。DoT 也走这里，所以中毒挨打同样涨怒。 */
export function applyDamage(target: BattleUnit, amount: number, crit = false): DamageOutcome {
  const dealt = Math.max(0, Math.min(target.stats.hp, Math.round(amount)));
  target.stats.hp -= dealt;

  let spGain = dealt * BALANCE.spGainPerDamageTaken;
  const bonus = target.statuses.reduce(
    (sum, status) => sum + (status.def.spGainBonus ?? 0),
    0,
  );
  spGain *= 1 + bonus;

  const spGained = dealt > 0 ? gainSp(target, spGain) : 0;

  return {
    dealt,
    crit,
    defeated: target.stats.hp <= 0,
    spGained,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
