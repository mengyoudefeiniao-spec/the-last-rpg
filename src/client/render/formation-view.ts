import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { Formation } from '../../shared/data/types.ts';

/**
 * 阵图：把阵法的阵位与连线画在地上。
 *
 * 阵图只在布阵阶段显眼，开战后会淡下去 —— 它的作用是让玩家一眼看懂「这个阵什么形状、
 * 谁站在哪」，战斗中再抢眼就只是噪音了。
 *
 * 换阵法不重建这个对象，直接 setFormation —— 顶栏那个临时入口可以来回切着看。
 */
export class FormationView {
  private readonly group = new THREE.Group();
  private readonly linkMaterial: THREE.MeshBasicMaterial;
  private readonly nodeMaterial: THREE.MeshBasicMaterial;
  private readonly pieceHolder = new THREE.Group();

  private labels: CSS2DObject[] = [];

  constructor(formation: Formation) {
    this.linkMaterial = new THREE.MeshBasicMaterial({
      color: formation.color,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    this.nodeMaterial = new THREE.MeshBasicMaterial({
      color: formation.color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.group.add(this.pieceHolder);
    this.setFormation(formation);
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  /** 整体显隐与浓淡。布阵阶段全亮，开战后淡到几乎看不见。 */
  setProminence(prominent: boolean): void {
    this.linkMaterial.opacity = prominent ? 0.7 : 0.12;
    this.nodeMaterial.opacity = prominent ? 0.85 : 0.18;
    for (const label of this.labels) {
      label.visible = prominent;
    }
  }

  setFormation(formation: Formation): void {
    // 清掉旧阵图（含标签的 DOM）
    for (const label of this.labels) {
      this.pieceHolder.remove(label);
      label.element.remove();
    }
    this.labels = [];

    while (this.pieceHolder.children.length > 0) {
      const child = this.pieceHolder.children[0];
      if (!child) break;
      this.pieceHolder.remove(child);
      disposeDeep(child);
    }

    this.linkMaterial.color.setHex(formation.color);
    this.nodeMaterial.color.setHex(formation.color);

    // 连线：用细长立方体而不是 Line —— WebGL 的线宽大多被驱动忽略，1px 的线太不显眼
    for (const link of formation.links) {
      const from = formation.slots[link.from];
      const to = formation.slots[link.to];
      if (!from || !to) continue;

      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.001) continue;

      const bar = new THREE.Mesh(new THREE.BoxGeometry(length, 0.02, 0.13), this.linkMaterial);
      bar.position.set((from.x + to.x) / 2, 0.045, (from.z + to.z) / 2);
      bar.rotation.y = -Math.atan2(dz, dx);
      this.pieceHolder.add(bar);
    }

    // 阵位：一个圆环 + 中心点，外加角色名标签
    formation.slots.forEach((slot, index) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.44, 26), this.nodeMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(slot.x, 0.05, slot.z);
      this.pieceHolder.add(ring);

      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 18), this.nodeMaterial);
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(slot.x, 0.05, slot.z);
      this.pieceHolder.add(dot);

      const label = document.createElement('div');
      label.className = 'formation-role';
      label.textContent = `${index + 1}·${slot.role}`;

      const labelObject = new CSS2DObject(label);
      labelObject.position.set(slot.x, 0.3, slot.z - 0.75);
      this.pieceHolder.add(labelObject);
      this.labels.push(labelObject);
    });
  }

  dispose(): void {
    for (const label of this.labels) label.element.remove();
    this.labels = [];
    this.linkMaterial.dispose();
    this.nodeMaterial.dispose();
    disposeDeep(this.group);
  }
}

/** 释放子树的几何体（材质是共享的，由外面统一释放）。 */
function disposeDeep(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
  });
}
