import './ui/styles.css';

import type { ServerMessage } from '../shared/protocol.ts';
import { BattleClient } from './net/battle-client.ts';
import { BattleStage } from './render/battle-stage.ts';
import { BattleMirror } from './state/battle-mirror.ts';
import { BattleView } from './ui/battle-view.ts';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('找不到 #app 容器');

/**
 * 客户端装配。
 *
 * 依赖方向：mirror 从服务端推来的快照与心跳填充，stage 与 view 只读 mirror；
 * 玩家意图则原样转发给服务端，中途不做任何本地状态修改。
 *
 * 有两类下行消息要分开对待：`tick` 只更新行动条（高频），`snapshot` 才是完整状态。
 */
const mirror = new BattleMirror();

let stage: BattleStage | null = null;
let view: BattleView;

const client = new BattleClient({
  onMessage: (message) => enqueue(message),
  onStatusChange: (status, detail) => view.setConnectionStatus(status, detail),
});

/** 换一场仗（重开 / 改队伍配置）时，3D 场景必须整个重建：单位、阵图、天气都换了。 */
function resetStage(): void {
  stage?.dispose();
  stage = null;
}

view = new BattleView(app, mirror, {
  onBeginBattle: () => client.send({ type: 'beginBattle' }),
  /** 为某个条已满的单位下达指令 —— 只有它能动。 */
  onAct: (unitId, action) => client.send({ type: 'act', unitId, action }),
  onTriggerEvent: (eventId) => client.send({ type: 'triggerEvent', eventId }),
  onRestart: () => {
    resetStage();
    client.send({ type: 'restart' });
  },
  onSavePartyConfig: (patch) => {
    resetStage();
    client.send({ type: 'savePartyConfig', ...patch });
  },
});

/** 消息串行处理：演出是异步的，不能让两条快照的播放交错在一起。 */
let queue: Promise<void> = Promise.resolve();

function enqueue(message: ServerMessage): void {
  queue = queue
    .then(() => handleMessage(message))
    .catch((error: unknown) => {
      console.error('[client] 处理服务端消息失败', error);
    });
}

async function handleMessage(message: ServerMessage): Promise<void> {
  if (message.type === 'error') {
    view.showError(message.message);
    return;
  }

  // 行动条心跳：只更新条的位置与「谁能操作」，不碰别的
  if (message.type === 'tick') {
    mirror.applyTick(message.tick.gauges, message.tick.awaitingUnitIds);
    view.refreshGauges();
    return;
  }

  const { snapshot, records } = message;

  // 首次同步（或换局之后）：这时才拿到战场、阵法与场景，才能把 3D 舞台建起来
  if (!stage) {
    mirror.applySnapshot(snapshot);
    stage = new BattleStage(view.stageContainer, mirror, {
      onUnitPick: (unitId) => view.pickUnit(unitId),
    });
    view.attachStage(stage);
    view.refresh();
    return;
  }

  // 先在「旧状态」下把演出播完，再对齐权威快照 —— 血条才会跟着动作走，而不是先跳到位。
  // 注意：服务端**不会**等我们播完，行动条在演出期间照常推进，
  // 所以这里偶尔会积压一两条快照，这是正常的。
  await stage.playRecords(records);
  mirror.applySnapshot(snapshot);
  view.refresh();
}

client.connect();
