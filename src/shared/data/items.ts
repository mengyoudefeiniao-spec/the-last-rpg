import type { ItemDef } from './types.ts';

/**
 * 道具表 —— 纯数据，逻辑在 systems/battle/battle.ts 的 useItem 分支。
 *
 * 本作道具**一律单体**：只能对我方一个人用。所以每一条的 target 都是 'ally'，
 * 没有「群体回复」这种东西 —— 要加的话得先在 ItemDef 里补一种 target。
 *
 * 原型阶段数值内联在此，将来搬到 data/items/ 由数据驱动（见 data/README.md）。
 */
const ITEM_DEFS = {
  // ---------- 恢复气血 ----------
  hpSalve: {
    id: 'hpSalve',
    name: '金创药',
    desc: '回复 80 点生命。',
    kind: 'heal',
    target: 'ally',
    heal: { resource: 'hp', scale: { mode: 'flat', amount: 80 } },
  },
  hpPaste: {
    id: 'hpPaste',
    name: '生肌膏',
    desc: '回复 35% 最大生命。',
    kind: 'heal',
    target: 'ally',
    heal: { resource: 'hp', scale: { mode: 'percent', percent: 0.35 } },
  },
  hpElixir: {
    id: 'hpElixir',
    name: '大还丹',
    desc: '生命全满。',
    kind: 'heal',
    target: 'ally',
    heal: { resource: 'hp', scale: { mode: 'full' } },
  },

  // ---------- 恢复法力 ----------
  mpTea: {
    id: 'mpTea',
    name: '清心茶',
    desc: '回复 40 点法力。',
    kind: 'heal',
    target: 'ally',
    heal: { resource: 'mp', scale: { mode: 'flat', amount: 40 } },
  },
  mpDew: {
    id: 'mpDew',
    name: '凝露散',
    desc: '回复 35% 最大法力。',
    kind: 'heal',
    target: 'ally',
    heal: { resource: 'mp', scale: { mode: 'percent', percent: 0.35 } },
  },
  mpSpring: {
    id: 'mpSpring',
    name: '灵泉髓',
    desc: '法力全满。',
    kind: 'heal',
    target: 'ally',
    heal: { resource: 'mp', scale: { mode: 'full' } },
  },

  // ---------- 解除异常 ----------
  cureOne: {
    id: 'cureOne',
    name: '解毒散',
    desc: '解除中毒。',
    kind: 'cure',
    target: 'ally',
    cure: { mode: 'some', statusIds: ['poison'] },
  },
  cureMany: {
    id: 'cureMany',
    name: '清心丸',
    desc: '解除中毒、灼烧与迟滞。',
    kind: 'cure',
    target: 'ally',
    cure: { mode: 'some', statusIds: ['poison', 'burn', 'spdDown'] },
  },
  cureAll: {
    id: 'cureAll',
    name: '还魂香',
    desc: '解除身上所有异常状态。',
    kind: 'cure',
    target: 'ally',
    cure: { mode: 'all' },
  },

  // ---------- 增益 ----------
  spdPill: {
    id: 'spdPill',
    name: '疾风丹',
    desc: '速度 +40%，持续 3 轮。',
    kind: 'buff',
    target: 'ally',
    buffStatus: 'spdUp',
  },
  atkPill: {
    id: 'atkPill',
    name: '神力丹',
    desc: '攻击力 +30%，持续 3 轮。',
    kind: 'buff',
    target: 'ally',
    buffStatus: 'atkUp',
  },
  magPill: {
    id: 'magPill',
    name: '灵犀丹',
    desc: '法术强度 +35%，持续 3 轮。',
    kind: 'buff',
    target: 'ally',
    buffStatus: 'magUp',
  },
  defPill: {
    id: 'defPill',
    name: '金刚丹',
    desc: '防御力 +50%，持续 3 轮。',
    kind: 'buff',
    target: 'ally',
    buffStatus: 'defUp',
  },
  resPill: {
    id: 'resPill',
    name: '玄玉丹',
    desc: '法术抗性 +40%，持续 3 轮。',
    kind: 'buff',
    target: 'ally',
    buffStatus: 'resUp',
  },
} satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEM_DEFS;

export function getItemDef(id: string): ItemDef | undefined {
  return (ITEM_DEFS as Record<string, ItemDef>)[id];
}

/** 全部道具定义，UI 需要列表时用。 */
export function listItems(): ItemDef[] {
  return Object.values(ITEM_DEFS) as ItemDef[];
}

/**
 * 开局给队伍带上的道具。
 *
 * 数值是原型阶段的拍脑袋配置 —— 每种都放几个，好把「恢复 / 解除 / 增益」
 * 三条路都试得到。等掉落与商店做出来，这里就该由存档决定了。
 */
export const STARTING_ITEMS: ReadonlyArray<{ itemId: string; count: number }> = [
  { itemId: 'hpSalve', count: 4 },
  { itemId: 'hpPaste', count: 2 },
  { itemId: 'hpElixir', count: 1 },
  { itemId: 'mpTea', count: 3 },
  { itemId: 'mpDew', count: 2 },
  { itemId: 'mpSpring', count: 1 },
  { itemId: 'cureOne', count: 2 },
  { itemId: 'cureMany', count: 1 },
  { itemId: 'cureAll', count: 1 },
  { itemId: 'spdPill', count: 1 },
  { itemId: 'atkPill', count: 1 },
  { itemId: 'magPill', count: 1 },
  { itemId: 'defPill', count: 1 },
  { itemId: 'resPill', count: 1 },
];
