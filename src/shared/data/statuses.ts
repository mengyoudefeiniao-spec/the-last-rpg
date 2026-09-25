import type { StatusDef } from './types.ts';

/**
 * 状态效果表 —— 纯数据，不含逻辑（逻辑在 systems/battle/status-effects.ts）。
 *
 * 放在 data/ 层是有意的：data/battlefields.ts 要为地形效果引用具体状态，
 * 若状态表躺在 systems/ 里，数据层就得反向依赖逻辑层。
 *
 * 约定：同名状态只存在一份，再次施加是「刷新持续时间」而不是叠加 —— 避免数值滚雪球。
 */
const STATUS_DEFS = {
  // ---------- 技能造成的减益 ----------
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

  // ---------- 技能造成的增益 ----------
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

  // ---------- 地形施加的状态 ----------
  // duration 给得很大：它们由「是否还站在区域内」决定去留，
  // 每回合开始被 terrain 同步逻辑刷新，而不是靠倒计时自然结束。
  frostbite: {
    id: 'frostbite',
    name: '冻伤',
    kind: 'debuff',
    duration: 99,
    modifiers: { spd: -0.25 },
    dot: { label: '冻伤', power: 0.04, mode: 'percentMaxHp' },
    trigger: 'actionEnd',
    desc: '速度 -25%，每回合结束损失 4% 最大生命',
  },
  scorched: {
    id: 'scorched',
    name: '灼地',
    kind: 'debuff',
    duration: 99,
    modifiers: { res: -0.2 },
    dot: { label: '灼地', power: 0.05, mode: 'percentMaxHp' },
    trigger: 'actionEnd',
    desc: '法术抗性 -20%，每回合结束损失 5% 最大生命',
  },
  springBlessing: {
    id: 'springBlessing',
    name: '仙源滋养',
    kind: 'buff',
    duration: 99,
    modifiers: { res: 0.2 },
    hot: { label: '仙源滋养', power: 0.06, mode: 'percentMaxHp' },
    trigger: 'actionEnd',
    desc: '法术抗性 +20%，每回合结束回复 6% 最大生命',
  },
  miasma: {
    id: 'miasma',
    name: '浊气侵体',
    kind: 'debuff',
    duration: 99,
    modifiers: { atk: -0.2, mag: -0.2 },
    trigger: 'turnStart',
    desc: '攻击与法术强度 -20%',
  },
} satisfies Record<string, StatusDef>;

export type StatusId = keyof typeof STATUS_DEFS;

export function getStatusDef(id: StatusId): StatusDef {
  return STATUS_DEFS[id];
}

/** 全部状态 id，UI 需要列全表时用。 */
export function listStatusIds(): StatusId[] {
  return Object.keys(STATUS_DEFS) as StatusId[];
}
