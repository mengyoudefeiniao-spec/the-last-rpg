import * as THREE from 'three';

import type { WeatherPreset } from '../../shared/data/types.ts';

/**
 * 天气粒子层。
 *
 * 一套粒子场通吃飞雪 / 骤雨 / 风沙 / 灵雾：数量、颜色、下落速度与斜度全由天气预设决定。
 * 粒子掉出范围就绕回另一端，所以密度永远恒定，不会越下越稀。
 *
 * 换天气不重建几何体，只改 drawRange 与材质 —— 切换才不会有卡顿。
 */
export class WeatherLayer {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly capacity: number;

  /** 粒子场的范围，覆盖整个战场还多一圈。 */
  private readonly halfWidth = 30;
  private readonly halfDepth = 30;
  private readonly topY = 26;

  private preset: WeatherPreset;
  private activeCount = 0;

  constructor(preset: WeatherPreset) {
    this.preset = preset;
    this.capacity = MAX_PARTICLES;

    this.positions = new Float32Array(this.capacity * 3);
    this.seedPositions(this.positions);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    this.material = new THREE.PointsMaterial({
      color: preset.color,
      size: preset.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    // 必须等 geometry 与 material 就位后再建 —— 类字段初始化顺序不允许提前引用它们
    this.points = new THREE.Points(this.geometry, this.material);
    this.applyPreset(preset);
  }

  get object(): THREE.Object3D {
    return this.points;
  }

  setPreset(preset: WeatherPreset): void {
    this.preset = preset;
    this.applyPreset(preset);
  }

  update(dt: number): void {
    if (this.activeCount === 0) return;

    const positions = this.positions;
    const fall = this.preset.fallSpeed * dt;
    const drift = this.preset.drift * dt;

    for (let i = 0; i < this.activeCount; i += 1) {
      const i3 = i * 3;

      positions[i3] = wrap(positions[i3]! + drift, -this.halfWidth, this.halfWidth);
      positions[i3 + 1] = wrap(positions[i3 + 1]! - fall, 0, this.topY);
      positions[i3 + 2] = wrap(
        positions[i3 + 2]! + drift * 0.35,
        -this.halfDepth,
        this.halfDepth,
      );
    }

    this.geometry.attributes['position']!.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private applyPreset(preset: WeatherPreset): void {
    this.activeCount = Math.min(preset.density, this.capacity);
    this.geometry.setDrawRange(0, this.activeCount);

    this.material.color.setHex(preset.color);
    this.material.size = preset.size;
    this.material.opacity = preset.kind === 'mist' ? 0.35 : 0.85;
    this.material.visible = this.activeCount > 0;
  }

  private seedPositions(target: Float32Array): void {
    for (let i = 0; i < this.capacity; i += 1) {
      const i3 = i * 3;
      target[i3] = (Math.random() * 2 - 1) * this.halfWidth;
      target[i3 + 1] = Math.random() * this.topY;
      target[i3 + 2] = (Math.random() * 2 - 1) * this.halfDepth;
    }
  }
}

/** 粒子数上限：够密，又不至于让软渲染扛不住。 */
const MAX_PARTICLES = 1600;

function wrap(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return min;
  let next = value;
  while (next < min) next += span;
  while (next > max) next -= span;
  return next;
}
