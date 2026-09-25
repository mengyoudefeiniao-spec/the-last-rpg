import type { ActiveStatus, Battlefield, BattlePosition, TerrainZone } from '../../data/types.ts';

/**
 * 地形逻辑。
 *
 * 只有这里知道「站位如何影响状态」，别处不许再写一份 —— 地形效果一旦散落成多处判断，
 * 加一个新地形就要改 N 个地方，那正是要避免的扩展性 bug。
 */

/** 地形施加的状态的 sourceId 前缀。 */
export const TERRAIN_SOURCE_PREFIX = 'terrain:';

export function terrainSourceId(zoneId: string): string {
  return `${TERRAIN_SOURCE_PREFIX}${zoneId}`;
}

/** 这个状态是不是地形给的（离开区域时应当移除）。 */
export function isTerrainStatus(status: ActiveStatus): boolean {
  return status.sourceId.startsWith(TERRAIN_SOURCE_PREFIX);
}

/**
 * 落在哪个地形分区内。
 * 不在任何区域内返回 undefined；区域重叠时取「相对深度」更靠内的那个
 * （比较 距离/半径 而不是绝对距离，否则大圈会无脑压过小圈）。
 */
export function zoneAt(
  battlefield: Battlefield,
  position: BattlePosition,
): TerrainZone | undefined {
  let best: TerrainZone | undefined;
  let bestDepth = Number.POSITIVE_INFINITY;

  for (const zone of battlefield.zones) {
    const distance = Math.hypot(position.x - zone.center.x, position.z - zone.center.z);
    if (distance > zone.radius) continue;

    const depth = zone.radius > 0 ? distance / zone.radius : 0;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = zone;
    }
  }

  return best;
}

/**
 * 判断某单位当前**应当**拥有的地形状态。
 * 返回 { zoneId, statusIds } —— 纯计算，实际增删由 Battle 执行，便于测试。
 */
export function desiredTerrainEffects(
  battlefield: Battlefield,
  position: BattlePosition,
): { zone: TerrainZone | undefined; statusIds: string[] } {
  const zone = zoneAt(battlefield, position);
  return {
    zone,
    statusIds: zone ? zone.effects.map((effect) => effect.id) : [],
  };
}
