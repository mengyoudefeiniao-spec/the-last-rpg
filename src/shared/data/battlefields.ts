import { getStatusDef } from './statuses.ts';
import type { Battlefield, BattlePosition, StageEventArea } from './types.ts';

/**
 * 战场定义表：敌方阵位 + 地形分区。
 *
 * 注意这里**没有我方阵位** —— 我方的站位由阵法（formations.ts）决定。
 * 所以同一张战场换个阵法，地形取舍就完全不同：锋矢阵的锋头可能正踩在灼地里，
 * 而方圆阵的中军却安稳待在灵泉上。
 *
 * 坐标是 three.js 场景坐标（x 向右、z 朝镜头）。
 * 我方在 +x/+z（画面右下），敌方在 -x/-z（画面左上）。
 */

/** 敌方阵型槽位。敌方不设阵法，用战场自带的这一套。 */
const ENEMY_SLOTS: BattlePosition[] = [
  { x: -1.4, z: -3.6 },
  { x: -4.2, z: -4.4 },
  { x: -7.0, z: -5.2 },
  { x: -2.8, z: -7.4 },
  { x: -5.6, z: -8.2 },
];

/**
 * 战场上方的事件区。
 *
 * **目前完全不渲染** —— 它只是给剧情事件预留的锚点：海啸、地震、渡劫天雷之类
 * 都从这里降临。三个战场共用同一个位置，因为它锚在「战场正上方」，与地形无关。
 */
const EVENT_AREA: StageEventArea = {
  center: { x: 0, y: 26, z: 0 },
  radius: 16,
  height: 14,
  note: '剧情事件入口：海啸、地震、渡劫天雷等自此处降临',
};

const BATTLEFIELDS: Record<string, Battlefield> = {
  'snow-ridge': {
    id: 'snow-ridge',
    name: '雪山·寒鸦岭',
    desc: '风雪封谷，后排的溪谷常年不化，久站必生冻伤。',
    enemySlots: ENEMY_SLOTS,
    eventArea: EVENT_AREA,
    zones: [
      {
        id: 'zone.frozen-creek',
        name: '冰封溪谷',
        kind: 'snow',
        center: { x: 4.2, z: 7.8 },
        radius: 2.4,
        effects: [getStatusDef('frostbite')],
        desc: '站位于此的单位持续冻伤：速度 -25%，每回合结束损失 4% 最大生命',
      },
      {
        id: 'zone.frost-fang',
        name: '霜牙崖',
        kind: 'snow',
        center: { x: -4.2, z: -7.8 },
        radius: 2.4,
        effects: [getStatusDef('frostbite')],
        desc: '敌方后阵的冻土，效果同冰封溪谷',
      },
    ],
  },

  'flame-rift': {
    id: 'flame-rift',
    name: '炎域·地火裂口',
    desc: '地脉外泄，前排脚下的裂缝不断喷出灼气。',
    enemySlots: ENEMY_SLOTS,
    eventArea: EVENT_AREA,
    zones: [
      {
        id: 'zone.ember-crack',
        name: '地火裂缝',
        kind: 'flame',
        center: { x: 4.2, z: 4.6 },
        radius: 3.0,
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
    enemySlots: ENEMY_SLOTS,
    eventArea: EVENT_AREA,
    zones: [
      {
        id: 'zone.spirit-spring',
        name: '灵泉',
        kind: 'spring',
        center: { x: 4.4, z: 6.0 },
        radius: 2.6,
        effects: [getStatusDef('springBlessing')],
        desc: '站位于此的单位受灵泉滋养：法术抗性 +20%，每回合结束回复 6% 最大生命',
      },
      {
        id: 'zone.miasma-hollow',
        name: '浊气洼地',
        kind: 'miasma',
        center: { x: 7.2, z: 8.4 },
        radius: 2.2,
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

/** 取一份战场的**副本** —— 服务端会改写它，不该共享同一份对象。 */
export function getBattlefield(id: string): Battlefield {
  const found = BATTLEFIELDS[id] ?? BATTLEFIELDS[DEFAULT_BATTLEFIELD_ID];
  if (!found) throw new Error(`战场定义缺失：${id}`);
  return structuredClone(found);
}

/** 所有战场（副本）。 */
export function listBattlefields(): Battlefield[] {
  return Object.keys(BATTLEFIELDS).map((id) => getBattlefield(id));
}
