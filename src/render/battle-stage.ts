import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { BattleUnit, CommandId, PendingAction } from '../data/types.ts';
import type {
  Battle,
  BattleDirector,
  StatusReport,
  StrikeReport,
} from '../systems/battle/battle.ts';
import { isAlive } from '../systems/battle/battle-unit.ts';
import { Animator } from './animator.ts';
import './battle-stage.css';

/**
 * 敌方站位：画面左上（-x 在左、-z 在远）。
 * 前排 3 人靠近己方、后排 2 人靠镜头，后排横向错开卡在前排的间隙里。
 * 前后排的 z 差要留够 —— 透视投影会把它们在屏幕上压扁，站太近血条就会糊成一片。
 */
const ENEMY_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [-1.4, -3.6],
  [-4.2, -4.4],
  [-7.0, -5.2],
  [-2.8, -7.4],
  [-5.6, -8.2],
];

/** 我方站位：画面右下（+x 在右、+z 在近），与敌方镜像。 */
const ALLY_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [1.4, 3.6],
  [4.2, 4.4],
  [7.0, 5.2],
  [2.8, 7.4],
  [5.6, 8.2],
];

/** 这几类指令是「冲上去打」，演出时会移动到目标身前。 */
const MELEE_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'attack',
  'skill',
  'talisman',
]);

/**
 * 演出各段的时长（秒，均按 1 倍速计）。
 * 一次行动的完整链条 ≈ 0.08 + 0.22 + 0.12 + 0.24 + 0.18 ≈ 0.84 秒，
 * 十人一回合约 8 秒 —— 所以默认给了 2 倍速档，否则节奏会拖到让人以为卡住。
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

export interface BattleStageOptions {
  /** 需要玩家点选目标时，点中某个单位后回调它的 id。 */
  onUnitPick?: (unitId: string) => void;
}

interface UnitView {
  unit: BattleUnit;
  /** 位置与朝向。 */
  group: THREE.Group;
  /** 倒地用的倾斜层，独立于血条，免得血条跟着躺下。 */
  tilt: THREE.Group;
  bodyMaterial: THREE.MeshStandardMaterial;
  homePosition: THREE.Vector3;
  homeRotationY: number;
  ring: THREE.Mesh;
  bar: {
    root: HTMLElement;
    name: HTMLElement;
    hp: HTMLElement;
    mp: HTMLElement;
    sp: HTMLElement;
    statuses: HTMLElement;
  };
  /** 上次同步到 DOM 的值，避免每帧写 DOM。 */
  synced: {
    hp: number;
    mp: number;
    sp: number;
    statusKey: string;
    defending: boolean;
    down: boolean;
    targetable: boolean;
  };
  fallen: boolean;
}

/**
 * 3D 战场：固定视角的立体战场 + 头顶血条 + 行动演出。
 *
 * 实现 BattleDirector —— 战斗逻辑在每个动作点 await 这里，等演出播完再继续。
 * 视角规则（按需求）：commandInput 阶段可自由旋转缩放，其余阶段锁定。
 */
export class BattleStage implements BattleDirector {
  private readonly container: HTMLElement;
  private readonly battle: Battle;
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

  private frame = 0;
  private disposed = false;
  private targetable = false;
  private pointerDownAt: { x: number; y: number } | undefined;
  private resizeObserver: ResizeObserver | undefined;

  constructor(container: HTMLElement, battle: Battle, options: BattleStageOptions = {}) {
    this.container = container;
    this.battle = battle;
    this.onUnitPick = options.onUnitPick;

    const { clientWidth: width, clientHeight: height } = container;
    const w = Math.max(1, width);
    const h = Math.max(1, height);

    // ---------------------------- 渲染器 ----------------------------
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

    // ---------------------------- 相机 ----------------------------
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
    this.buildUnits();

    // ---------------------------- 事件 ----------------------------
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.frame = requestAnimationFrame(this.tick);
  }

  // ==========================================================================
  // BattleDirector —— 演出
  // ==========================================================================

  /** 回合开始：全体归位站好，清掉上一轮的姿态残留。 */
  onTurnStart(): void {
    for (const view of this.views.values()) {
      if (!isAlive(view.unit) || view.fallen) continue;
      view.group.position.copy(view.homePosition);
      view.group.rotation.y = view.homeRotationY;
      view.tilt.rotation.x = 0;
    }
  }

  async beforeAction(
    actor: BattleUnit,
    action: PendingAction,
    target: BattleUnit | undefined,
  ): Promise<void> {
    const view = this.views.get(actor.id);
    if (!view) return;

    const targetView = target ? this.views.get(target.id) : undefined;

    // 转向目标
    if (targetView) {
      view.group.rotation.y = angleTo(view.group.position, targetView.group.position);
      await this.animator.wait(TIMING.turnToTarget);
    }

    if (targetView && MELEE_COMMANDS.has(action.commandId)) {
      // 近战：冲到目标身前，再挥击一下
      const from = view.group.position.clone();
      const to = approachPoint(from, targetView.group.position);

      await this.animator.tween(TIMING.lunge, (t) => {
        view.group.position.lerpVectors(from, to, t);
      });
      await this.animator.tween(TIMING.swing, (t) => {
        view.tilt.rotation.x = Math.sin(t * Math.PI) * 0.28;
      });
    } else if (action.commandId !== 'defend' && action.commandId !== 'flee') {
      // 远程 / 群体 / 召唤：原地蓄力（微微上浮）
      await this.animator.tween(TIMING.charge, (t) => {
        view.group.position.y = Math.sin(t * Math.PI) * 0.22;
      });
    }
  }

  async onStrike(report: StrikeReport): Promise<void> {
    const view = this.views.get(report.target.id);
    if (!view) return;

    if (report.damage > 0) {
      // 飘字不阻塞流程 —— 它只是视觉残留，让它自己慢慢淡出
      void this.popText(`-${report.damage}`, view, report.crit ? 'crit' : 'damage');
      await this.flashHit(view);
    } else if (report.healing > 0) {
      void this.popText(`+${report.healing}`, view, 'heal');
    } else if (report.label) {
      void this.popText(report.label, view, 'info');
    }

    if (report.defeated) await this.fallDown(view);
  }

  async onStatus(report: StatusReport): Promise<void> {
    const view = this.views.get(report.unit.id);
    if (!view) return;

    void this.popText(report.name, view, report.kind === 'buff' ? 'buff' : 'debuff');
    await this.animator.wait(TIMING.statusBeat);
  }

  /** 行动结束：回到自己的站位与朝向。 */
  async afterAction(actor: BattleUnit): Promise<void> {
    const view = this.views.get(actor.id);
    if (!view || view.fallen) return;

    const start = view.group.position.clone();
    const fromRotation = view.group.rotation.y;

    const needsReturn =
      start.distanceTo(view.homePosition) > 0.02 ||
      Math.abs(start.y) > 0.02 ||
      Math.abs(fromRotation - view.homeRotationY) > 0.02;

    if (!needsReturn) return;

    await this.animator.tween(TIMING.returnHome, (t) => {
      view.group.position.set(
        start.x + (view.homePosition.x - start.x) * t,
        start.y + (view.homePosition.y - start.y) * t,
        start.z + (view.homePosition.z - start.z) * t,
      );
      view.group.rotation.y = fromRotation + (view.homeRotationY - fromRotation) * t;
    });

    view.group.position.copy(view.homePosition);
    view.group.rotation.y = view.homeRotationY;
  }

  // ==========================================================================
  // 对外控制
  // ==========================================================================

  /** 是否允许旋转/缩放视角。按需求：只有指令阶段开放。 */
  setInteractive(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (enabled) this.controls.update();
  }

  /** 是否处于「点敌人选目标」状态。 */
  setTargetable(enabled: boolean): void {
    this.targetable = enabled;
  }

  /** 高亮当前正在下指令的我方单位。 */
  setActiveUnit(unitId: string | undefined): void {
    for (const [id, view] of this.views) {
      view.bar.root.classList.toggle('is-active', id === unitId);
    }
  }

  /** 演出速度倍率。1 = 常规。 */
  setSpeed(speed: number): void {
    this.animator.speed = speed;
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

  private buildEnvironment(): void {
    this.scene.background = new THREE.Color(0x0a0f18);
    this.scene.fog = new THREE.Fog(0x0a0f18, 30, 62);

    const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x11161f, 1.1);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffe6bd, 2.0);
    key.position.set(9, 17, 11);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.0012;
    this.scene.add(key);

    // 地面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 64),
      new THREE.MeshStandardMaterial({ color: 0x1b2533, roughness: 0.95, metalness: 0.05 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 网格（用暗色，只做空间参考）
    const grid = new THREE.GridHelper(64, 64, 0x2f4358, 0x1f2c3c);
    grid.position.y = 0.005;
    this.scene.add(grid);

    // 两阵营的分界线，强化「敌上我下」的构图
    const divider = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 26),
      new THREE.MeshBasicMaterial({ color: 0x3d5570, transparent: true, opacity: 0.5 }),
    );
    divider.rotation.x = -Math.PI / 2;
    divider.position.y = 0.01;
    this.scene.add(divider);
  }

  private buildUnits(): void {
    const allies = this.battle.units.filter((unit) => unit.side === 'ally');
    const enemies = this.battle.units.filter((unit) => unit.side === 'enemy');

    allies.forEach((unit, index) => this.createUnitView(unit, index));
    enemies.forEach((unit, index) => this.createUnitView(unit, index));
  }

  private createUnitView(unit: BattleUnit, index: number): void {
    const isAlly = unit.side === 'ally';
    const slots = isAlly ? ALLY_SLOTS : ENEMY_SLOTS;
    const palette = isAlly ? ALLY_COLORS : ENEMY_COLORS;

    const slot = slots[index % slots.length] as readonly [number, number];
    const color = palette[index % palette.length] as number;

    const group = new THREE.Group();
    group.position.set(slot[0], 0, slot[1]);

    // 朝战场中心站，敌我自然相对
    const homeRotationY = angleTo(group.position, new THREE.Vector3(0, 0, 0));
    group.rotation.y = homeRotationY;

    // 倒地倾斜层：血条挂在 group 上而不是这里，免得血条跟着躺下
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

    // 脚下的站位环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.56, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    tilt.add(ring);

    // 影子
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.46, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    tilt.add(shadow);

    // 拾取用的不可见碰撞体：比模型大一圈，点击更友好
    const pickBox = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.72, 2.3, 10),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pickBox.position.y = 1.15;
    pickBox.userData['unitId'] = unit.id;
    group.add(pickBox);
    this.pickables.push(pickBox);

    // 头顶血条
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

    nameEl.textContent = unit.name;

    const label = new CSS2DObject(bar);
    label.position.set(0, 2.15, 0);
    group.add(label);

    this.scene.add(group);

    this.views.set(unit.id, {
      unit,
      group,
      tilt,
      bodyMaterial,
      homePosition: group.position.clone(),
      homeRotationY,
      ring,
      bar: {
        root: bar,
        name: nameEl as HTMLElement,
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
        targetable: false,
      },
      fallen: false,
    });
  }

  // ==========================================================================
  // 演出细节
  // ==========================================================================

  /** 受击：闪红 + 沿受击方向轻退。 */
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

  /** 倒下：绕 X 轴躺平、下沉、变暗。 */
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
  }

  /**
   * 飘字：临时挂一个 CSS2D 元素，上浮淡出。
   * 调用方通常不 await —— 它只影响观感，不该拖住战斗流程。
   */
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
    this.syncBars();
    this.syncRingPulse();

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  /** 把单位状态同步到头顶血条。只在数值真的变了时才写 DOM。 */
  private syncBars(): void {
    for (const view of this.views.values()) {
      const { stats, statuses } = view.unit;
      const alive = isAlive(view.unit);
      const synced = view.synced;

      if (synced.hp !== stats.hp) {
        view.bar.hp.style.width = `${percent(stats.hp, stats.maxHp)}%`;
        synced.hp = stats.hp;
      }
      if (synced.mp !== stats.mp) {
        view.bar.mp.style.width = `${percent(stats.mp, stats.maxMp)}%`;
        synced.mp = stats.mp;
      }
      if (synced.sp !== stats.sp) {
        view.bar.sp.style.width = `${percent(stats.sp, stats.maxSp)}%`;
        synced.sp = stats.sp;
      }

      const statusKey = statuses.map((s) => `${s.def.id}:${s.remaining}`).join(',');
      if (synced.statusKey !== statusKey) {
        view.bar.statuses.replaceChildren(
          ...statuses.map((status) => {
            const chip = document.createElement('span');
            chip.className = `unit-bar__status unit-bar__status--${status.def.kind}`;
            chip.textContent = `${status.def.name}${status.remaining}`;
            chip.title = status.def.desc;
            return chip;
          }),
        );
        synced.statusKey = statusKey;
      }

      if (synced.defending !== view.unit.isDefending) {
        view.bar.root.classList.toggle('is-defending', view.unit.isDefending);
        synced.defending = view.unit.isDefending;
      }

      const down = !alive;
      if (synced.down !== down) {
        view.bar.root.classList.toggle('is-down', down);
        synced.down = down;
      }

      const targetable = this.targetable && view.unit.side === 'enemy' && alive;
      if (synced.targetable !== targetable) {
        view.bar.root.classList.toggle('is-targetable', targetable);
        synced.targetable = targetable;
      }
    }
  }

  /** 存活单位的站位环轻微呼吸，让画面不至于是死的。 */
  private syncRingPulse(): void {
    const pulse = 0.4 + Math.sin(this.clock.elapsedTime * 1.6) * 0.12;
    for (const view of this.views.values()) {
      if (view.fallen || !isAlive(view.unit)) continue;
      const material = view.ring.material as THREE.MeshBasicMaterial;
      material.opacity = pulse;
    }
  }

  private handleResize(): void {
    const { clientWidth, clientHeight } = this.container;
    const w = Math.max(1, clientWidth);
    const h = Math.max(1, clientHeight);

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

    if (!down || !this.targetable || !this.onUnitPick) return;
    // 拖着转视角时不当作「点选目标」
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    const unitId = hit?.object.userData['unitId'];
    if (typeof unitId === 'string') this.onUnitPick(unitId);
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
