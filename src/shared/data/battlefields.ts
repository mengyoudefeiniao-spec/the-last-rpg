import { getStatusDef } from './statuses.ts';
import type { Battlefield, BattlePosition } from './types.ts';

/**
 * 战场定义表：阵型槽位 + 地形分区。
 *
 * 站位坐标是 three.js 场景坐标（x 向右、z 朝镜头）。
 * 我方在 +x/+z（画面右下），敌方在 -x/-z（画面左上）。
 */

/** 我方阵型槽位：前排 3 人靠敌方，后排 2 人靠镜头。 */
const ALLY_SLOTS: BattlePosition[] = [
  { x: 1.4, z: 3.6 },
  { x: 4.2, z: 4.4 },
  { x: 7.0, z: 5.2 },
  { x: 2.8, z: 7.4 },
  { x: 5.6, z: 8.2 },
];

/** 敌方阵型槽位，与我方镜像。 */
const ENEMY_SLOTS: BattlePosition[] = [
  { x: -1.4, z: -3.6 },
  { x: -4.2, z: -4.4 },
  { x: -7.0, z: -5.2 },
  { x: -2.8, z: -7.4 },
  { x: -5.6, z: -8.2 },
];

/**
 * 三个战场。
 *
 * 设计意图：让「站在哪里」有真实代价 —— 每个战场的危险/有益区域都只盖住部分槽位，
 * 玩家必须在布阵阶段做取舍，这就是后面阵法系统的立足点。
 */
const BATTLEFIELDS: Record<string, Battlefield> = {
  'snow-ridge': {
    id: 'snow-ridge',
    name: '雪山·寒鸦岭',
    desc: '风雪封谷，后排的溪谷常年不化，久站必生冻伤。',
    allySlots: ALLY_SLOTS,
    enemySlots: ENEMY_SLOTS,
    zones: [
      {
        id: 'zone.frozen-creek',
        name: '冰封溪谷',
        kind: 'snow',
        center: { x: 4.2, z: 7.8 },
        radius: 2.2,
        // 盖住我方两个后排槽位 (2.8,7.4) 与 (5.6,8.2)
        effects: [getStatusDef('frostbite')],
        desc: '站位于此的单位持续冻伤：速度 -25%，每回合结束损失 4% 最大生命',
      },
      {
        id: 'zone.frost-fang',
        name: '霜牙崖',
        kind: 'snow',
        center: { x: -4.2, z: -7.8 },
        radius: 2.2,
        // 盖住敌方两个后排槽位，双方代价对等
        effects: [getStatusDef('frostbite')],
        desc: '敌方后阵的冻土，效果同冰封溪谷',
      },
    ],
  },

  'flame-rift': {
    id: 'flame-rift',
    name: '炎域·地火裂口',
    desc: '地脉外泄，前排脚下的裂缝不断喷出灼气。',
    allySlots: ALLY_SLOTS,
    enemySlots: ENEMY_SLOTS,
    zones: [
      {
        id: 'zone.ember-crack',
        name: '地火裂缝',
        kind: 'flame',
        center: { x: 4.2, z: 4.4 },
        radius: 3.0,
        // 盖住我方全部三个前排槽位
        effects: [getStatusDef('scorched')],
        desc: '站位于此的单位持续灼地：法术抗性 -20%，每回合结束损失 5% 最大生命',
      },
      {
        id: 'zone.lava-mouth',
        name: '熔岩口',
        kind: 'flame',
        center: { x: -4.2, z: -4.4 },
        radius: 3.0,
        effects: [getStatusDef('scorched')],
        desc: '敌方前阵的熔岩口，效果同地火裂缝',
      },
    ],
  },

  'immortal-spring': {
    id: 'immortal-spring',
    name: '仙源之地·灵泉',
    desc: '地脉灵眼涌出的泉水滋养万物 —— 但低洼处淤积的浊气也不是好惹的。',
    allySlots: ALLY_SLOTS,
    enemySlots: ENEMY_SLOTS,
    zones: [
      {
        id: 'zone.spirit-spring',
        name: '灵泉',
        kind: 'spring',
        center: { x: 4.2, z: 5.9 },
        radius: 2.2,
        // 盖住我方 (4.2,4.4) 与 (2.8,7.4) 两个槽位
        effects: [getStatusDef('springBlessing')],
        desc: '站位于此的单位受灵泉滋养：法术抗性 +20%，每回合结束回复 6% 最大生命',
      },
      {
        id: 'zone.miasma-hollow',
        name: '浊气洼地',
        kind: 'miasma',
        center: { x: 7.0, z: 5.2 },
        radius: 1.9,
        // 单独咬住我方最靠右的槽位，逼玩家在「输出位」与「灵泉」之间取舍
        effects: [getStatusDef('miasma')],
        desc: '站位于此的单位被浊气侵体：攻击与法术强度 -20%',
      },
      {
        id: 'zone.spirit-spring-foe',
        name: '灵泉（敌阵）',
        kind: 'spring',
        center: { x: -4.2, z: -5.9 },
        radius: 2.2,
        effects: [getStatusDef('springBlessing')],
        desc: '敌方半场的灵泉，效果与我方一致',
      },
    ],
  },
};

export const DEFAULT_BATTLEFIELD_ID = 'snow-ridge';

/** 取一份战场的**副本** —— 服务端会改写槽位与单位站位，不能共享同一份对象。 */
export function getBattlefield(id: string): Battlefield {
  const found = BATTLEFIELDS[id] ?? BATTLEFIELDS[DEFAULT_BATTLEFIELD_ID];
  if (!found) throw new Error(`战场定义缺失：${id}`);
  return structuredClone(found);
}

/** 所有战场（副本）。 */
export function listBattlefields(): Battlefield[] {
  return Object.keys(BATTLEFIELDS).map((id) => getBattlefield(id));
}
