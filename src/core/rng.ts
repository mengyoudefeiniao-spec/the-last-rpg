/**
 * 可复现的伪随机数发生器（mulberry32）。
 * 固定 seed 就能重放同一场战斗 —— 这是战斗逻辑能被测试的前提。
 */
export interface Rng {
  /** [0, 1) 均匀分布。 */
  next(): number;
  /** [min, max] 闭区间整数。 */
  int(min: number, max: number): number;
  /** 以概率 p 返回 true。 */
  chance(p: number): boolean;
  /** 从非空数组中等概率取一个。 */
  pick<T>(items: readonly T[]): T;
  /** 按权重取一个，权重需为非负数且总和大于 0。 */
  weighted<T>(items: readonly { item: T; weight: number }[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('Rng.pick: 数组为空');
      return items[Math.floor(next() * items.length)] as T;
    },
    weighted: <T>(items: readonly { item: T; weight: number }[]): T => {
      if (items.length === 0) throw new Error('Rng.weighted: 数组为空');
      const total = items.reduce((sum, entry) => sum + entry.weight, 0);
      if (total <= 0) throw new Error('Rng.weighted: 权重总和必须大于 0');
      let roll = next() * total;
      for (const entry of items) {
        roll -= entry.weight;
        if (roll <= 0) return entry.item;
      }
      return (items[items.length - 1] as { item: T; weight: number }).item;
    },
  };
}
