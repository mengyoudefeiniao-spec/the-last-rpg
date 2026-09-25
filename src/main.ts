import './ui/styles.css';

import { createSampleBattleUnits } from './data/sample-battle.ts';
import { BattleStage } from './render/battle-stage.ts';
import { Battle } from './systems/battle/battle.ts';
import { createUnit } from './systems/battle/battle-unit.ts';
import { BattleView } from './ui/battle-view.ts';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('找不到 #app 容器');

let view: BattleView | null = null;
let stage: BattleStage | null = null;

/** 装配一场战斗并挂到界面上。每次调用都是全新的战斗，互不影响。 */
function mount(seed: number): void {
  // 先拆旧的：stage 要停掉渲染循环与补间，view 要解除事件订阅
  stage?.dispose();
  view?.destroy();

  const units = createSampleBattleUnits().map(createUnit);
  const battle = new Battle({ units, seed });

  app!.replaceChildren();

  view = new BattleView(app!, battle, { onRestart: () => mount(seed + 1) });
  stage = new BattleStage(view.stageContainer, battle, {
    onUnitPick: (unitId) => view?.pickTarget(unitId),
  });

  // 依赖倒置：战斗逻辑只认得 BattleDirector 接口，不知道背后是 three.js
  battle.director = stage;
  view.attachStage(stage);

  battle.start().catch((error: unknown) => {
    console.error('[battle] 启动失败', error);
  });
}

mount(Math.floor(Math.random() * 1_000_000));
