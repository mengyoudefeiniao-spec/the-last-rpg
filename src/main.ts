import './ui/styles.css';

import { createSampleBattleUnits } from './data/sample-battle.ts';
import { Battle } from './systems/battle/battle.ts';
import { createUnit } from './systems/battle/battle-unit.ts';
import { BattleView } from './ui/battle-view.ts';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('找不到 #app 容器');

let view: BattleView | null = null;

/** 装配一场战斗并挂到界面上。每次调用都是全新的战斗，互不影响。 */
function mount(seed: number): void {
  view?.destroy();

  const units = createSampleBattleUnits().map(createUnit);
  const battle = new Battle({ units, seed });

  app!.replaceChildren();
  view = new BattleView(app!, battle, { onRestart: () => mount(seed + 1) });

  battle.start();
}

mount(Math.floor(Math.random() * 1_000_000));
