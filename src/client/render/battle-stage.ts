import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { CommandId, TerrainKind } from '../../shared/data/types.ts';
import type { BattleRecord, UnitSnapshot } from '../../shared/protocol.ts';
import { zoneAt } from '../../shared/systems/battle/terrain.ts';
import type { BattleMirror } from '../state/battle-mirror.ts';
import { Animator } from './animator.ts';
import { FormationView } from './formation-view.ts';
import { WeatherLayer } from './weather.ts';
import './battle-stage.css';

/** 这几类指令是「冲上去打」，演出时会移动到目标身前。 */
const MELEE_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'attack',
  'skill',
  'talisman',
]);

/**
 * 演出各段的时长（秒，按 1 倍速计）。
 * 一次行动的完整链条 ≈ 0.08 + 0.22 + 0.12 + 0.24 + 0.18 ≈ 0.84 秒，
 * 十人一回合约 8 秒 —— 所以默认给 2 倍速档，否则节奏会拖到让人以为卡住。
 */
const TIMING = {
  turnToTarget: 0.08,
  lunge: 0.22,
  swing: 0.12,
  charge: 0.18,
  hitFlash: 0.24,
  statusBeat: 0.15,
  fall: 0.45,
  floatText: 0.8,
  returnHome: 0.18,
} as const;

const ALLY_COLORS = [0x64d2bf, 0x6f9ef0, 0x7fd98a, 0xbf9af0, 0xf0c063];
const ENEMY_COLORS = [0xc75d5d, 0xb1604a, 0xa0528f, 0x8f6a4a, 0x9b5a6b];

/** 地形配色 —— 与 CSS 里 .zone-label--* 的色系保持一致。 */
const TERRAIN_COLORS: Record<TerrainKind, number> = {
  snow: 0x7fb8e8,
  flame: 0xe07040,
  spring: 0x5fd8a8,
  miasma: 0x9b6bd8,
};

/** 战争迷雾般的环境底色。 */
const FOG_COLOR = 0x0a0f18;

/** 点击拾取的语义：谁可以被点。 */
export type PickMode = 'none' | 'enemy' | 'ally';

export interface BattleStageOptions {
  onUnitPick?: (unitId: string) => void;
}

interface UnitView {
  id: string;
  group: THREE.Group;
  /** 倒地倾斜层，独立于血条，免得血条跟着躺下。 */
  tilt: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  /** 单位自身颜色 —— 离开地形后脚下光环要恢复成它。 */
  homeRingColor: number;
  /** 站位（会随布阵换位变化）。 */
  homePosition: THREE.Vector3;
  homeRotationY: number;
  bar: {
    root: HTMLElement;
    hp: HTMLElement;
    mp: HTMLElement;
    sp: HTMLElement;
    statuses: HTMLElement;
  };
  synced: {
    hp: number;
    mp: number;
    sp: number;
    statusKey: string;
    defending: boolean;
    down: boolean;
    active: boolean;
    pickable: boolean;
    zoneId: string;
  };
  fallen: boolean;
  /** 演出中由动画接管位置，逐帧同步不得插手。 */
  animating: boolean;
}

/**
 * 3D 战场：固定机位的立体战场 + 地形分区 + 头顶血条 + 演出播放。
 *
 * 它只读 BattleMirror —— 也就是服务端推来的快照，从不自己推导任何战斗结果。
 * 服务端给的 records 是「怎么演」，mirror 是「是什么」，两者的职责在类型上就是分开的。
 */
export class BattleStage {
  private readonly container: HTMLElement;
  private readonly mirror: BattleMirror;
  private readonly onUnitPick: ((unitId: string) => void) | undefined;

  private readonly animator = new Animator();
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer = new CSS2DRenderer();
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private readonly views = new Map<string, UnitView>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly terrainGroup = new THREE.Group();
  /** 阵图。布阵阶段显眼，开打之后淡下去。 */
  private readonly formationView: FormationView | null;
  /** 天气粒子。「晴」这种 density 为 0 的天气没有粒子层。 */
  private readonly weatherLayer: WeatherLayer | null;
  /** 阵图当前浓淡 —— 缓存一下，免得每帧都写材质。 */
  private formationProminent = true;

  private frame = 0;
  private disposed = false;
  private pickMode: PickMode = 'none';
  private activeUnitId: string | undefined;
  private pointerDownAt: { x: number; y: number } | undefined;
  private resizeObserver: ResizeObserver | undefined;

  constructor(container: HTMLElement, mirror: BattleMirror, options: BattleStageOptions = {}) {
    this.container = container;
    this.mirror = mirror;
    this.onUnitPick = options.onUnitPick;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer.setSize(w, h);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.inset = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 240);
    // 俯角约 50°：再平就把前后排压扁，再陡就失去立体感
    this.camera.position.set(0, 19, 16);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;
    // 别让玩家转到敌我背后，「敌方在左上」这个构图才有意义
    this.controls.minAzimuthAngle = -Math.PI * 0.55;
    this.controls.maxAzimuthAngle = Math.PI * 0.55;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.28;
    this.controls.minDistance = 16;
    this.controls.maxDistance = 46;
    this.controls.update();

    this.buildEnvironment();
    this.buildTerrain();
    this.formationView = this.buildFormation();
    this.weatherLayer = this.buildWeather();
    this.buildUnits();

    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.frame = requestAnimationFrame(this.tick);
  }

  // ==========================================================================
  // 演出播放 —— 把服务端给的记录逐条演出来
  // ==========================================================================

  /** 播放一组记录。期间 mirror.playing 为 true，UI 据此锁住输入。 */
  async playRecords(records: readonly BattleRecord[]): Promise<void> {
    if (records.length === 0) return;

    this.mirror.playing = true;
    try {
      for (const record of records) {
        await this.playRecord(record);
      }
    } finally {
      this.mirror.playing = false;
    }
  }

  private async playRecord(record: BattleRecord): Promise<void> {
    switch (record.kind) {
      case 'roundStart':
        this.resetStances();
        break;

      case 'beforeAction':
        await this.playBeforeAction(record.actorId, record.commandId, record.targetId);
        break;

      case 'strike':
        // 先让血条跟到这条记录结算后的值，再播受击 —— 视觉与数字才是一起动的
        this.mirror.applyRecord(record);
        await this.playStrike(record.targetId, record.damage, record.healing, record.crit, record.defeated, record.label);
        break;

      case 'status':
        await this.playStatus(record.unitId, record.name, record.statusKind);
        break;

      case 'afterAction':
        await this.playAfterAction(record.actorId);
        break;

      case 'stageEvent':
        await this.playStageEvent(record.anchor, record.name, record.text);
        break;
    }
  }

  /**
   * 剧情事件演出：从天而降。
   *
   * 一道雷柱自事件区（战场上方那块**不渲染**的区域）直插战场，同时压下一道强光与横幅。
   * 海啸、地震、渡劫天雷这类效果共用这一个入口 —— 加新事件不需要动这里。
   */
  private async playStageEvent(
    anchor: { x: number; y: number; z: number },
    name: string,
    text: string,
  ): Promise<void> {
    const boltMaterial = new THREE.MeshBasicMaterial({
      color: 0xcfe8ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    const bolt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.52, anchor.y, 12),
      boltMaterial,
    );
    bolt.position.set(anchor.x, anchor.y / 2, anchor.z);
    this.scene.add(bolt);

    const glow = new THREE.PointLight(0xcfe8ff, 0, anchor.y * 2);
    glow.position.set(anchor.x, anchor.y * 0.7, anchor.z);
    this.scene.add(glow);

    this.showBanner(name, text);

    // 劈落
    await this.animator.tween(0.18, (t) => {
      boltMaterial.opacity = 0.9 - t * 0.3;
      bolt.scale.x = 1 + t * 0.8;
      bolt.scale.z = 1 + t * 0.8;
      glow.intensity = t * 320;
    });

    // 余晖散去
    await this.animator.tween(0.55, (t) => {
      boltMaterial.opacity = 0.6 * (1 - t);
      bolt.scale.y = 1 - t * 0.12;
      glow.intensity = 320 * (1 - t);
    });

    this.scene.remove(bolt);
    this.scene.remove(glow);
    bolt.geometry.dispose();
    boltMaterial.dispose();
  }

  /** 战场上方的一次性横幅，用于剧情事件。 */
  private showBanner(name: string, text: string): void {
    const element = document.createElement('div');
    element.className = 'stage-banner';

    const title = document.createElement('b');
    title.textContent = name;
    const subtitle = document.createElement('span');
    subtitle.textContent = text;
    element.append(title, subtitle);

    const object = new CSS2DObject(element);
    object.position.set(0, 7.5, 0);
    this.scene.add(object);

    void this.animator
      .tween(1.8, (t) => {
        element.style.opacity = String(
          t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.12) / 0.88),
        );
      })
      .then(() => {
        this.scene.remove(object);
        element.remove();
      });
  }

  /** 回合开始：全体归位站好，清掉上一轮的姿态残留。 */
  private resetStances(): void {
    for (const view of this.views.values()) {
      const unit = this.mirror.unitById(view.id);
      if (!unit?.alive || view.fallen) continue;

      view.group.position.copy(view.homePosition);
      view.group.rotation.y = view.homeRotationY;
      view.tilt.rotation.x = 0;
    }
  }

  private async playBeforeAction(
    actorId: string,
    commandId: CommandId,
    targetId: string | null,
  ): Promise<void> {
    const view = this.views.get(actorId);
    if (!view) return;

    const targetView = targetId ? this.views.get(targetId) : undefined;
    view.animating = true;

    if (targetView) {
      view.group.rotation.y = angleTo(view.group.position, targetView.group.position);
      await this.animator.wait(TIMING.turnToTarget);
    }

    if (targetView && MELEE_COMMANDS.has(commandId)) {
      const from = view.group.position.clone();
      const to = approachPoint(from, targetView.group.position);

      await this.animator.tween(TIMING.lunge, (t) => {
        view.group.position.lerpVectors(from, to, t);
      });
      await this.animator.tween(TIMING.swing, (t) => {
        view.tilt.rotation.x = Math.sin(t * Math.PI) * 0.28;
      });
    } else if (commandId !== 'defend' && commandId !== 'flee') {
      await this.animator.tween(TIMING.charge, (t) => {
        view.group.position.y = Math.sin(t * Math.PI) * 0.22;
      });
    }
  }

  private async playStrike(
    targetId: string,
    damage: number,
    healing: number,
    crit: boolean,
    defeated: boolean,
    label: string,
  ): Promise<void> {
    const view = this.views.get(targetId);
    if (!view) return;

    if (damage > 0) {
      // 飘字不阻塞流程 —— 它只是视觉残留，让它自己慢慢淡出
      void this.popText(`-${damage}`, view, crit ? 'crit' : 'damage');
      await this.flashHit(view);
    } else if (healing > 0) {
      void this.popText(`+${healing}`, view, 'heal');
    } else if (label) {
      void this.popText(label, view, 'info');
    }

    if (defeated) await this.fallDown(view);
  }

  private async playStatus(
    unitId: string,
    name: string,
    statusKind: 'buff' | 'debuff',
  ): Promise<void> {
    const view = this.views.get(unitId);
    if (!view) return;

    void this.popText(name, view, statusKind);
    await this.animator.wait(TIMING.statusBeat);
  }

  /** 行动结束：回到自己的站位与朝向。 */
  private async playAfterAction(actorId: string): Promise<void> {
    const view = this.views.get(actorId);
    if (!view) return;

    view.animating = true;
    try {
      const start = view.group.position.clone();
      const fromRotation = view.group.rotation.y;

      const needsReturn =
        Math.abs(start.x - view.homePosition.x) > 0.02 ||
        Math.abs(start.z - view.homePosition.z) > 0.02 ||
        Math.abs(start.y) > 0.02 ||
        Math.abs(fromRotation - view.homeRotationY) > 0.02;

      if (needsReturn) {
        await this.animator.tween(TIMING.returnHome, (t) => {
          view.group.position.set(
            start.x + (view.homePosition.x - start.x) * t,
            start.y + (view.homePosition.y - start.y) * t,
            start.z + (view.homePosition.z - start.z) * t,
          );
          view.group.rotation.y = fromRotation + (view.homeRotationY - fromRotation) * t;
        });
      }

      view.group.position.copy(view.homePosition);
      view.group.rotation.y = view.homeRotationY;
      view.tilt.rotation.x = 0;
    } finally {
      view.animating = false;
    }
  }

  // ==========================================================================
  // 对外控制
  // ==========================================================================

  /** 是否允许旋转/缩放视角。按需求：布阵与指令阶段开放，行动期间锁死。 */
  setInteractive(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (enabled) this.controls.update();
  }

  setPickMode(mode: PickMode): void {
    this.pickMode = mode;
  }

  setActiveUnit(unitId: string | undefined): void {
    this.activeUnitId = unitId;
  }

  /** 演出速度倍率。1 = 常规。 */
  setSpeed(speed: number): void {
    this.animator.speed = speed;
  }

  /** 强制把所有单位摆到快照给的位置（重开一局时用，不走平滑过渡）。 */
  syncNow(): void {
    for (const view of this.views.values()) {
      const unit = this.mirror.unitById(view.id);
      if (!unit) continue;

      this.applyHome(view, unit);
      view.group.position.copy(view.homePosition);
      view.group.rotation.y = view.homeRotationY;
      this.resetUnitPose(view, unit);
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    // 先结束补间，否则挂起的 await 永远不返回
    this.animator.clear();

    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.formationView?.dispose();
    this.weatherLayer?.dispose();

    this.scene.traverse((object) => {
      const mesh = object as Partial<THREE.Mesh>;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
    this.container.replaceChildren();
    this.views.clear();
  }

  // ==========================================================================
  // 场景搭建
  // ==========================================================================

  /**
   * 搭建场景外观。
   * 颜色、雾气、光照全部来自服务端下发的环境主题 —— 想让战斗发生在雪原还是焦土上，
   * 只改队伍配置里的 environmentId，这里一行都不用动。
   */
  private buildEnvironment(): void {
    const theme = this.mirror.scenery?.environment;

    this.scene.background = new THREE.Color(theme?.sky ?? FOG_COLOR);
    this.scene.fog = new THREE.Fog(
      theme?.fog ?? FOG_COLOR,
      theme?.fogNear ?? 30,
      theme?.fogFar ?? 62,
    );

    this.scene.add(
      new THREE.HemisphereLight(
        theme?.hemiSky ?? 0x9fc4ff,
        theme?.hemiGround ?? 0x11161f,
        1.1,
      ),
    );

    const key = new THREE.DirectionalLight(theme?.keyLight ?? 0xffe6bd, theme?.keyIntensity ?? 2.0);
    const lightDirection: readonly [number, number, number] = theme?.keyDirection ?? [9, 17, 11];
    key.position.set(lightDirection[0], lightDirection[1], lightDirection[2]);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.0012;
    this.scene.add(key);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 64),
      new THREE.MeshStandardMaterial({
        color: theme?.ground ?? 0x1b2533,
        roughness: 0.95,
        metalness: 0.05,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(
      64,
      64,
      theme?.gridMajor ?? 0x2f4358,
      theme?.gridMinor ?? 0x1f2c3c,
    );
    grid.position.y = 0.005;
    this.scene.add(grid);

    const divider = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 26),
      new THREE.MeshBasicMaterial({ color: 0x3d5570, transparent: true, opacity: 0.5 }),
    );
    divider.rotation.x = -Math.PI / 2;
    divider.position.y = 0.01;
    this.scene.add(divider);

    this.scene.add(this.terrainGroup);
  }

  /** 阵图：把阵法的阵位与连线画在地上。没有阵法数据就不画。 */
  private buildFormation(): FormationView | null {
    const formation = this.mirror.formation;
    if (!formation || formation.slots.length === 0) return null;

    const view = new FormationView(formation);
    view.setProminence(this.mirror.phase === 'deployment');
    this.formationProminent = this.mirror.phase === 'deployment';
    this.scene.add(view.object);
    return view;
  }

  /** 天气粒子。「晴」这类 density 为 0 的天气不建粒子层。 */
  private buildWeather(): WeatherLayer | null {
    const weather = this.mirror.scenery?.weather;
    if (!weather || weather.density <= 0) return null;

    const layer = new WeatherLayer(weather);
    this.scene.add(layer.object);
    return layer;
  }

  /** 地形分区：半透明圆盘 + 边缘环 + 名称标签。 */
  private buildTerrain(): void {
    const battlefield = this.mirror.battlefield;
    if (!battlefield) return;

    for (const zone of battlefield.zones) {
      const color = TERRAIN_COLORS[zone.kind];

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(zone.radius, 56),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(zone.center.x, 0.02, zone.center.z);
      this.terrainGroup.add(disc);

      const rim = new THREE.Mesh(
        new THREE.RingGeometry(zone.radius * 0.955, zone.radius, 72),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(zone.center.x, 0.03, zone.center.z);
      this.terrainGroup.add(rim);

      const label = document.createElement('div');
      label.className = `zone-label zone-label--${zone.kind}`;
      label.textContent = zone.name;
      label.title = zone.desc;

      const labelObject = new CSS2DObject(label);
      // 摆在圆的靠镜头一侧，避免压住站在圈里的单位
      labelObject.position.set(
        zone.center.x,
        0.35,
        zone.center.z + zone.radius * 0.82,
      );
      this.terrainGroup.add(labelObject);
    }
  }

  private buildUnits(): void {
    for (const unit of this.mirror.units) {
      this.createUnitView(unit);
    }
  }

  private createUnitView(unit: UnitSnapshot): void {
    const isAlly = unit.side === 'ally';
    const palette = isAlly ? ALLY_COLORS : ENEMY_COLORS;
    const index = this.views.size;
    const color = palette[index % palette.length] as number;

    const group = new THREE.Group();
    group.position.set(unit.position.x, 0, unit.position.z);

    const tilt = new THREE.Group();
    group.add(tilt);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.2,
      emissive: new THREE.Color(0xff3020),
      emissiveIntensity: 0,
    });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.72, 6, 14), bodyMaterial);
    body.position.y = 0.86;
    body.castShadow = true;
    tilt.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xf0dfc4, roughness: 0.85, metalness: 0 }),
    );
    head.position.y = 1.5;
    head.castShadow = true;
    tilt.add(head);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.56, 28), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    tilt.add(ring);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.46, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    tilt.add(shadow);

    const pickBox = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.72, 2.3, 10),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pickBox.position.y = 1.15;
    pickBox.userData['unitId'] = unit.id;
    group.add(pickBox);
    this.pickables.push(pickBox);

    const bar = document.createElement('div');
    bar.className = `unit-bar unit-bar--${unit.side}`;
    bar.innerHTML = `
      <div class="unit-bar__name"></div>
      <div class="unit-bar__track"><i class="unit-bar__fill unit-bar__fill--hp"></i></div>
      <div class="unit-bar__track"><i class="unit-bar__fill unit-bar__fill--mp"></i></div>
      <div class="unit-bar__track unit-bar__track--thin"><i class="unit-bar__fill unit-bar__fill--sp"></i></div>
      <div class="unit-bar__statuses"></div>`;

    const nameEl = bar.querySelector('.unit-bar__name');
    const hpEl = bar.querySelector('.unit-bar__fill--hp');
    const mpEl = bar.querySelector('.unit-bar__fill--mp');
    const spEl = bar.querySelector('.unit-bar__fill--sp');
    const statusesEl = bar.querySelector('.unit-bar__statuses');
    if (!nameEl || !hpEl || !mpEl || !spEl || !statusesEl) {
      throw new Error('血条 DOM 结构不完整');
    }

    (nameEl as HTMLElement).textContent = unit.name;

    const label = new CSS2DObject(bar);
    label.position.set(0, 2.15, 0);
    group.add(label);

    this.scene.add(group);

    const view: UnitView = {
      id: unit.id,
      group,
      tilt,
      bodyMaterial,
      ring,
      ringMaterial,
      homeRingColor: color,
      homePosition: new THREE.Vector3(unit.position.x, 0, unit.position.z),
      homeRotationY: 0,
      bar: {
        root: bar,
        hp: hpEl as HTMLElement,
        mp: mpEl as HTMLElement,
        sp: spEl as HTMLElement,
        statuses: statusesEl as HTMLElement,
      },
      synced: {
        hp: -1,
        mp: -1,
        sp: -1,
        statusKey: '',
        defending: false,
        down: false,
        active: false,
        pickable: false,
        zoneId: '',
      },
      fallen: false,
      animating: false,
    };

    this.applyHome(view, unit);
    group.rotation.y = view.homeRotationY;
    this.resetUnitPose(view, unit);

    this.views.set(unit.id, view);
  }

  /** 把快照里的站位写进视图的「家」坐标与朝向。 */
  private applyHome(view: UnitView, unit: UnitSnapshot): void {
    view.homePosition.set(unit.position.x, 0, unit.position.z);
    view.homeRotationY = angleTo(view.homePosition, new THREE.Vector3(0, 0, 0));
  }

  /** 按快照把倒地之类的一次性姿态补齐（重连、重开时用）。 */
  private resetUnitPose(view: UnitView, unit: UnitSnapshot): void {
    const down = !unit.alive;
    view.fallen = down;
    view.tilt.rotation.x = down ? -Math.PI * 0.46 : 0;
    view.tilt.position.y = down ? -0.34 : 0;
    view.bodyMaterial.opacity = down ? 0.45 : 1;
    view.bodyMaterial.transparent = down;
    view.ring.visible = !down;
    view.bar.root.classList.toggle('is-down', down);
    view.synced.down = down;
  }

  // ==========================================================================
  // 演出细节
  // ==========================================================================

  private async flashHit(view: UnitView): Promise<void> {
    const material = view.bodyMaterial;
    const origin = view.group.position.clone();
    const back = new THREE.Vector3()
      .subVectors(view.group.position, new THREE.Vector3(0, 0, 0))
      .setY(0);

    if (back.lengthSq() > 0.0001) back.normalize().multiplyScalar(0.22);

    await this.animator.tween(TIMING.hitFlash, (t) => {
      const pulse = Math.sin(t * Math.PI);
      material.emissiveIntensity = pulse * 1.6;
      view.group.position.x = origin.x + back.x * pulse;
      view.group.position.z = origin.z + back.z * pulse;
    });

    material.emissiveIntensity = 0;
    view.group.position.x = origin.x;
    view.group.position.z = origin.z;
  }

  private async fallDown(view: UnitView): Promise<void> {
    if (view.fallen) return;
    view.fallen = true;

    await this.animator.tween(TIMING.fall, (t) => {
      view.tilt.rotation.x = -t * Math.PI * 0.46;
      view.tilt.position.y = -t * 0.34;
      view.bodyMaterial.opacity = 1 - t * 0.55;
      view.bodyMaterial.transparent = true;
    });

    view.ring.visible = false;
    view.bar.root.classList.add('is-down');
  }

  /** 飘字：临时挂一个 CSS2D 元素，上浮淡出。调用方通常不 await。 */
  private popText(text: string, view: UnitView, kind: string): Promise<void> {
    const element = document.createElement('div');
    element.className = `float-text float-text--${kind}`;
    element.textContent = text;

    const object = new CSS2DObject(element);
    const start = view.group.position.clone();
    start.y += 2.5;
    object.position.copy(start);
    this.scene.add(object);

    return this.animator
      .tween(TIMING.floatText, (t) => {
        object.position.y = start.y + t * 1.2;
        element.style.opacity = String(Math.max(0, 1 - t * t));
      })
      .then(() => {
        this.scene.remove(object);
        element.remove();
      });
  }

  // ==========================================================================
  // 每帧
  // ==========================================================================

  private readonly tick = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);

    const dt = Math.min(this.clock.getDelta(), 0.06);
    this.animator.update(dt);
    this.controls.update();
    this.syncPositions(dt);
    this.syncBars();
    this.syncRingPulse();
    this.weatherLayer?.update(dt);
    this.syncFormationProminence();

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  /** 阵图只在布阵阶段显眼 —— 开打之后它就是噪点了。 */
  private syncFormationProminence(): void {
    const prominent = this.mirror.phase === 'deployment';
    if (prominent === this.formationProminent) return;

    this.formationProminent = prominent;
    this.formationView?.setProminence(prominent);
  }

  /**
   * 站位同步：快照里的 position 变了（布阵换位）就平滑挪过去。
   * 演出期间不动 —— 那时候位置归动画管。
   */
  private syncPositions(dt: number): void {
    const k = Math.min(1, dt * 9);

    for (const view of this.views.values()) {
      const unit = this.mirror.unitById(view.id);
      if (!unit) continue;

      this.applyHome(view, unit);
      if (view.animating || view.fallen) continue;

      const { x, z } = view.homePosition;
      const dx = x - view.group.position.x;
      const dz = z - view.group.position.z;

      if (Math.abs(dx) < 0.004 && Math.abs(dz) < 0.004) {
        view.group.position.x = x;
        view.group.position.z = z;
        continue;
      }

      view.group.position.x += dx * k;
      view.group.position.z += dz * k;
    }
  }

  /** 把快照同步到头顶血条。只在值真的变了时才写 DOM。 */
  private syncBars(): void {
    for (const view of this.views.values()) {
      const unit = this.mirror.unitById(view.id);
      if (!unit) continue;

      const synced = view.synced;
      const hp = this.mirror.displayHp(unit);
      const { mp, sp, maxHp, maxMp, maxSp } = unit.stats;

      if (synced.hp !== hp) {
        view.bar.hp.style.width = `${percent(hp, maxHp)}%`;
        synced.hp = hp;
      }
      if (synced.mp !== mp) {
        view.bar.mp.style.width = `${percent(mp, maxMp)}%`;
        synced.mp = mp;
      }
      if (synced.sp !== sp) {
        view.bar.sp.style.width = `${percent(sp, maxSp)}%`;
        synced.sp = sp;
      }

      const statusKey = unit.statuses
        .map((status) => `${status.id}:${status.remaining}`)
        .join(',');
      if (synced.statusKey !== statusKey) {
        view.bar.statuses.replaceChildren(
          ...unit.statuses.map((status) => {
            const chip = document.createElement('span');
            // 地形施加的状态用虚线框区分，免得玩家以为是被某个技能挂上的
            chip.className = [
              'unit-bar__status',
              `unit-bar__status--${status.kind}`,
              status.fromTerrain ? 'unit-bar__status--terrain' : '',
            ]
              .filter(Boolean)
              .join(' ');
            chip.textContent = `${status.name}${status.remaining}`;
            chip.title = status.desc;
            return chip;
          }),
        );
        synced.statusKey = statusKey;
      }

      if (synced.defending !== unit.isDefending) {
        view.bar.root.classList.toggle('is-defending', unit.isDefending);
        synced.defending = unit.isDefending;
      }

      const down = !unit.alive;
      if (synced.down !== down) {
        view.bar.root.classList.toggle('is-down', down);
        synced.down = down;
      }

      const pickable =
        (this.pickMode === 'enemy' && unit.side === 'enemy' && unit.alive) ||
        (this.pickMode === 'ally' && unit.side === 'ally' && unit.alive);
      if (synced.pickable !== pickable) {
        view.bar.root.classList.toggle('is-pickable', pickable);
        synced.pickable = pickable;
      }

      if (synced.active !== (this.activeUnitId === unit.id)) {
        synced.active = this.activeUnitId === unit.id;
        view.bar.root.classList.toggle('is-active', synced.active);
        view.ringMaterial.opacity = synced.active ? 0.95 : 0.45;
      }

      // 站在地形里的单位，脚下光环换成地形色
      const battlefield = this.mirror.battlefield;
      const zone = battlefield ? zoneAt(battlefield, unit.position) : undefined;
      const zoneId = zone?.id ?? '';
      if (synced.zoneId !== zoneId) {
        synced.zoneId = zoneId;
        view.ringMaterial.color.setHex(
          zone ? (TERRAIN_COLORS[zone.kind] as number) : view.homeRingColor,
        );
      }
    }
  }

  /** 存活单位的站位环轻微呼吸，让画面不至于是死的。 */
  private syncRingPulse(): void {
    const pulse = 0.4 + Math.sin(this.clock.elapsedTime * 1.6) * 0.12;
    for (const view of this.views.values()) {
      if (view.fallen) continue;
      view.ringMaterial.opacity = this.activeUnitId === view.id ? 0.95 : pulse;
    }
  }

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownAt;
    this.pointerDownAt = undefined;

    if (!down || this.pickMode === 'none' || !this.onUnitPick) return;
    // 拖着转视角时不当作「点选」
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    const unitId = hit?.object.userData['unitId'];
    if (typeof unitId !== 'string') return;

    const unit = this.mirror.unitById(unitId);
    if (!unit?.alive) return;
    if (this.pickMode === 'enemy' && unit.side !== 'enemy') return;
    if (this.pickMode === 'ally' && unit.side !== 'ally') return;

    this.onUnitPick(unitId);
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 从 from 指向 to 的水平朝向（模型正面为 +z）。 */
function angleTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** 近战站位：目标身前 1.35 格。 */
function approachPoint(from: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const direction = new THREE.Vector3().subVectors(from, target).setY(0);
  if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1);
  direction.normalize().multiplyScalar(1.35);

  return new THREE.Vector3(target.x + direction.x, 0, target.z + direction.z);
}

function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
