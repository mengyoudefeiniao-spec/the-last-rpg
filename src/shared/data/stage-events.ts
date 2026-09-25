import type { StageEventDef } from './types.ts';

/**
 * 剧情事件表。
 *
 * 这些事件从战场上方的事件区（StageEventArea）降临，不属于任何一个单位。
 * 将来接剧情系统时，就是往这张表里加条目、由剧情来触发 ——
 * 现在只有一个演示用的天雷，用来验证「事件 → 服务端结算 → 客户端演出」这条链路。
 */
const STAGE_EVENTS: Record<string, StageEventDef> = {
  thunder: {
    id: 'thunder',
    name: '渡劫天雷',
    desc: '天雷自云层劈落，全场上下一同承受。',
    text: '天穹骤然一亮 —— 渡劫天雷轰然落下！',
    damagePercent: 0.12,
    kind: 'magical',
    color: 0xbfe4ff,
  },
};

/** 演示用的事件 —— 界面上那个「天雷」按钮指的就是它。 */
export const DEMO_EVENT_ID = 'thunder';

export function getStageEvent(id: string): StageEventDef {
  const found = STAGE_EVENTS[id];
  if (!found) throw new Error(`剧情事件定义缺失：${id}`);
  return structuredClone(found);
}

export function listStageEvents(): StageEventDef[] {
  return Object.keys(STAGE_EVENTS).map((id) => getStageEvent(id));
}
