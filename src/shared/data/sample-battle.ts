import type { BattleUnitInit } from './types.ts';

/**
 * 占位战斗数据：我方 5 人 vs 敌方 5 只。
 *
 * 正式数据将来由 data/characters/*.json 驱动（见 data/README.md），
 * 这里只为「看到一场完整战斗」这个原型目标服务。
 * 每次调用返回全新对象 —— 重开战斗不会带上上一场的血量。
 *
 * 数值口径：目标是「随机乱按指令」也能稳定获胜（tests/battle.spec.ts 会验证，
 * 30 个种子至少 24 胜）—— 玩家正常操作理应赢得更轻松，而不是更吃力。
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
        sp: 30,
      },
    },
    {
      id: 'char.shenmingzhu',
      name: '沈明烛',
      side: 'ally',
      stats: {
        maxHp: 260,
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
    {
      id: 'char.biluo',
      name: '碧落',
      side: 'ally',
      stats: {
        maxHp: 260,
        maxMp: 100,
        maxSp: 100,
        atk: 24,
        def: 18,
        mag: 40,
        res: 28,
        spd: 38,
        sp: 30,
      },
    },
    {
      id: 'char.qingwu',
      name: '青梧',
      side: 'ally',
      stats: {
        maxHp: 280,
        maxMp: 50,
        maxSp: 100,
        atk: 40,
        def: 20,
        mag: 14,
        res: 18,
        spd: 31,
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
        atk: 28,
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
        atk: 28,
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
        atk: 38,
        def: 26,
        mag: 22,
        res: 24,
        spd: 22,
      },
    },
    {
      id: 'enemy.serpent',
      name: '赤炼蛇妖',
      side: 'enemy',
      stats: {
        maxHp: 300,
        maxMp: 90,
        maxSp: 100,
        atk: 22,
        def: 16,
        mag: 36,
        res: 26,
        spd: 29,
      },
    },
    {
      id: 'enemy.corpse',
      name: '尸傀',
      side: 'enemy',
      stats: {
        maxHp: 380,
        maxMp: 10,
        maxSp: 100,
        atk: 30,
        def: 34,
        mag: 8,
        res: 12,
        spd: 14,
      },
    },
  ];
}
