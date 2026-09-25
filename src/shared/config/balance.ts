/**
 * 平衡参数。调数值只改这里，不要散落进各系统（见 src/README.md）。
 */
export const BALANCE = {
  /** 伤害随机浮动范围：±10%。 */
  damageVariance: 0.1,
  /** 伤害下限，避免高防单位被完全免疫。 */
  minDamage: 1,
  /** 暴击率，仅对物理攻击与特技生效。 */
  critChance: 0.1,
  /** 暴击倍率。 */
  critMultiplier: 1.5,
  /** 防御姿态的减伤比例。 */
  defendReduction: 0.5,
  /** 防御姿态期间额外获得的 SP。 */
  defendSpReward: 10,
  /** 物理防御对伤害的抵消系数。 */
  defFactor: 0.6,
  /** 法术抗性对伤害的抵消系数。 */
  resFactor: 0.6,
  /** 受击获得的 SP = 实际伤害 × 该系数。 */
  spGainPerDamageTaken: 0.6,
  /** 每回合自然回复的 SP。 */
  spRegenPerTurn: 6,
  /** 每回合自然回复的 MP。 */
  mpRegenPerTurn: 3,
  /** 逃跑基础成功率。 */
  fleeBaseChance: 0.45,
  /** 逃跑判定中，速度每领先 1 点带来的概率加成。 */
  fleeSpdFactor: 0.03,
  /** 逃跑失败后额外获得的 SP（总得给点补偿）。 */
  fleeFailSpReward: 12,
  /** 捕捉基础成功率。 */
  captureBaseChance: 0.15,
  /** 目标剩余 HP 越低，捕捉成功率越高的权重。 */
  captureHpWeight: 0.6,
  /** 敌人 AI 选择特技的血量阈值。 */
  aiSkillHpThreshold: 0.5,
} as const;
