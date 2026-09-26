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
  /** 防御姿态额外获得的 SP。防御姿态本身持续到该单位下次条满为止。 */
  defendSpReward: 10,
  /** 物理防御对伤害的抵消系数。 */
  defFactor: 0.6,
  /** 法术抗性对伤害的抵消系数。 */
  resFactor: 0.6,
  /** 每一轮自然回复的 SP。注意行动条下没有「回合」，以「全员各行动一次」为一轮。 */
  spRegenPerRound: 6,
  /** 每一轮自然回复的 MP。 */
  mpRegenPerRound: 3,
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

  // ------------------------------- 行动条 -------------------------------

  /** 行动值上限 —— 涨满即可行动。 */
  gaugeMax: 100,
  /**
   * 行动值推进系数：每点速度每秒推进多少行动值。
   * 速度 38 的单位约 3.3 秒涨满，速度 18 的约 7 秒 —— 快慢一眼就看得出来。
   */
  gaugeRate: 0.8,
  /**
   * 推进的时间步长（秒）。
   * advance() 会把一大段 dt 切成这么大的小步，免得一步就跨过「谁先到行动点」的细节。
   */
  gaugeStep: 0.05,
} as const;
