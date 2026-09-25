import type { Formation } from './types.ts';

/**
 * 阵法表 —— **只作用于我方**。
 *
 * 每个阵法的坐标都是照着阵名的字形摊到地面上的：
 * 锋矢是箭头、鹤翼是展开的翅膀、鱼鳞是错位的鳞片、长蛇是一条斜线、方圆是四角护中。
 *
 * 坐标用 three.js 场景坐标（x 向右、z 朝镜头）。我方在 +x/+z 一侧、敌方在 -x/-z，
 * 所以 **z 越小越靠近敌阵**，z 越大越靠后。
 */
const FORMATIONS: Record<string, Formation> = {
  'arrow-head': {
    id: 'arrow-head',
    name: '锋矢阵',
    desc: '全军缩成一个箭头，锋头直指敌阵 —— 突进最快，两翼最薄。',
    color: 0xffb347,
    slots: [
      { x: 4.2, z: 3.2, role: '锋头' },
      { x: 2.3, z: 5.4, role: '左翼' },
      { x: 6.1, z: 5.4, role: '右翼' },
      { x: 3.1, z: 7.9, role: '左尾' },
      { x: 5.3, z: 7.9, role: '右尾' },
    ],
    links: [
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 3, to: 4 },
    ],
  },

  'crane-wing': {
    id: 'crane-wing',
    name: '鹤翼阵',
    desc: '中军坐镇后方，两翼如鹤展翅向前包抄 —— 最考验两翼的强度。',
    color: 0x6ec6ff,
    slots: [
      { x: 4.2, z: 6.8, role: '中军' },
      { x: 2.5, z: 5.2, role: '左翼根' },
      { x: 1.3, z: 3.4, role: '左翼尖' },
      { x: 5.9, z: 5.2, role: '右翼根' },
      { x: 7.1, z: 3.4, role: '右翼尖' },
    ],
    links: [
      { from: 2, to: 1 },
      { from: 1, to: 0 },
      { from: 0, to: 3 },
      { from: 3, to: 4 },
      { from: 1, to: 3 },
    ],
  },

  'fish-scale': {
    id: 'fish-scale',
    name: '鱼鳞阵',
    desc: '前列三人密不透风，后列两人错位压上，层层叠叠如鱼鳞 —— 前排最硬。',
    color: 0x7fd98a,
    slots: [
      { x: 2.2, z: 4.1, role: '前列·左' },
      { x: 4.2, z: 3.6, role: '前列·中' },
      { x: 6.2, z: 4.1, role: '前列·右' },
      { x: 3.2, z: 6.4, role: '后列·左' },
      { x: 5.2, z: 6.4, role: '后列·右' },
    ],
    links: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 0, to: 3 },
      { from: 1, to: 3 },
      { from: 1, to: 4 },
      { from: 2, to: 4 },
    ],
  },

  'long-snake': {
    id: 'long-snake',
    name: '长蛇阵',
    desc: '一字长蛇横贯战场，首尾相顾 —— 铺得最开，也最怕被拦腰截断。',
    color: 0xc9a4ff,
    slots: [
      { x: 1.4, z: 3.6, role: '蛇首' },
      { x: 2.8, z: 4.9, role: '蛇颈' },
      { x: 4.2, z: 6.1, role: '蛇腰' },
      { x: 5.6, z: 7.3, role: '蛇身' },
      { x: 7.0, z: 8.6, role: '蛇尾' },
    ],
    links: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
    ],
  },

  'square-circle': {
    id: 'square-circle',
    name: '方圆阵',
    desc: '四角结阵护住中军，最稳也最慢 —— 守得住，但攻不出去。',
    color: 0xf0c063,
    slots: [
      { x: 4.2, z: 6.2, role: '中军' },
      { x: 2.1, z: 4.3, role: '前左角' },
      { x: 6.3, z: 4.3, role: '前右角' },
      { x: 2.1, z: 8.1, role: '后左角' },
      { x: 6.3, z: 8.1, role: '后右角' },
    ],
    links: [
      { from: 1, to: 2 },
      { from: 2, to: 4 },
      { from: 4, to: 3 },
      { from: 3, to: 1 },
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 0, to: 3 },
      { from: 0, to: 4 },
    ],
  },
};

export const DEFAULT_FORMATION_ID = 'arrow-head';

/** 取一份阵法的**副本** —— 服务端会拿它分派站位，不该共享同一份对象。 */
export function getFormation(id: string): Formation {
  const found = FORMATIONS[id] ?? FORMATIONS[DEFAULT_FORMATION_ID];
  if (!found) throw new Error(`阵法定义缺失：${id}`);
  return structuredClone(found);
}

/** 所有阵法（副本）。 */
export function listFormations(): Formation[] {
  return Object.keys(FORMATIONS).map((id) => getFormation(id));
}
