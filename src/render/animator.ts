/**
 * 极简补间动画器。
 *
 * 不引 tween 库：3D 演出只需要「给定 duration，每帧回调 t∈[0,1]，播完 resolve」这一件事。
 * 返回 Promise 是关键 —— 演出流程才能写成顺序的 await 链，而不是回调地狱。
 */
export type TweenFn = (t: number) => void;

interface TweenEntry {
  duration: number;
  elapsed: number;
  fn: TweenFn;
  resolve: () => void;
}

export class Animator {
  /**
   * 演出速度倍率，1 = 常规。
   * 放在这里而不是逐处改时长：所有补间共享同一条时间轴，调速才是一致的。
   */
  speed = 1;

  private readonly active = new Set<TweenEntry>();

  /** 补间。返回的 Promise 在播完后 resolve。 */
  tween(duration: number, fn: TweenFn): Promise<void> {
    if (duration <= 0) {
      fn(1);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.active.add({ duration, elapsed: 0, fn, resolve });
    });
  }

  /** 单纯等待若干秒。 */
  wait(duration: number): Promise<void> {
    return this.tween(duration, () => {});
  }

  /** 由渲染循环每帧调用。dt 是真实秒数，内部按 speed 缩放。 */
  update(dt: number): void {
    const scaled = dt * this.speed;

    for (const entry of [...this.active]) {
      entry.elapsed += scaled;
      const raw = Math.min(1, entry.elapsed / entry.duration);
      entry.fn(easeInOut(raw));

      if (raw >= 1) {
        this.active.delete(entry);
        entry.resolve();
      }
    }
  }

  /** 立刻结束所有补间（重开战斗时用），避免悬挂的 await 永远不返回。 */
  clear(): void {
    for (const entry of [...this.active]) {
      this.active.delete(entry);
      entry.fn(1);
      entry.resolve();
    }
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
