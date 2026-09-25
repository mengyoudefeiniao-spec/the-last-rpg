import type { BattleUnitInit } from './types.ts';

/**
 * 占位战斗数据：我方 3 人 vs 敌方 3 只。
 *
 * 正式数据将来由 data/characters/*.json 驱动（见 data/README.md），
 * 这里只为「能打一场完整战斗」这个原型目标服务。
 * 每次调用返回全新对象 —— 重开战斗不会带上上一场的血量。
 */
export function createSampleBattleUnits(): BattleUnitInit[] {
  return [
    // ----------------------------- 我方 -----------------------------
    {
      id: 'char.lingshuang',
      name: '凌霜',
      side: 'ally',
      stats: {
        maxHp: 340,
        maxMp: 60,
        maxSp: 100,
        atk: 44,
        def: 26,
        mag: 16,
        res: 20,
        spd: 34,
        // 演示便利：开局给 30 愤怒，让玩家第一回合就能试「特技」。
        // 正式平衡应该在 config/balance.ts 里定，而不是散在这里。
        sp: 30,
      },
    },
    {
      id: 'char.shenmingzhu',
      name: '沈明烛',
      side: 'ally',
      stats: {
        maxHp: 240,
        maxMp: 130,
        maxSp: 100,
        atk: 18,
        def: 16,
        mag: 48,
        res: 34,
        spd: 27,
        sp: 30,
      },
    },
    {
      id: 'char.aman',
      name: '阿蛮',
      side: 'ally',
      stats: {
        maxHp: 430,
        maxMp: 30,
        maxSp: 100,
        atk: 36,
        def: 40,
        mag: 8,
        res: 14,
        spd: 18,
        sp: 30,
      },
    },

    // ----------------------------- 敌方 -----------------------------
    {
      id: 'enemy.wolf-a',
      name: '妖狼·甲',
      side: 'enemy',
      stats: {
        maxHp: 190,
        maxMp: 20,
        maxSp: 100,
        atk: 32,
        def: 14,
        mag: 6,
        res: 8,
        spd: 31,
      },
    },
    {
      id: 'enemy.wolf-b',
      name: '妖狼·乙',
      side: 'enemy',
      stats: {
        maxHp: 190,
        maxMp: 20,
        maxSp: 100,
        atk: 32,
        def: 14,
        mag: 6,
        res: 8,
        spd: 31,
      },
    },
    {
      id: 'enemy.chieftain',
      name: '山魈首领',
      side: 'enemy',
      stats: {
        maxHp: 470,
        maxMp: 80,
        maxSp: 100,
        atk: 46,
        def: 26,
        mag: 26,
        res: 24,
        spd: 22,
      },
    },
  ];
}
