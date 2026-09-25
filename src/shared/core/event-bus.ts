export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/**
 * 极简类型安全事件总线。
 *
 * 战斗逻辑只管 emit，UI 与测试各自订阅 —— 这是「逻辑层不依赖 DOM」的关键：
 * 同一场战斗，浏览器里由 BattleView 渲染，Node 里由测试断言。
 */
export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set<Listener<never>>();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    // 复制一份再遍历，允许监听器在回调里取消订阅。
    for (const listener of [...set]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
