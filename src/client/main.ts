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
 * 注意这里的依赖方向：mirror 从服务端推来的快照填充，stage 与 view 只读 mirror；
 * 玩家意图则原样转发给服务端，中途不做任何本地状态修改。
 * 客户端唯一的「记忆」就是那份快照。
 */
const mirror = new BattleMirror();

let stage: BattleStage | null = null;
let view: BattleView;

const client = new BattleClient({
  onMessage: (message) => enqueue(message),
  onStatusChange: (status, detail) => view.setConnectionStatus(status, detail),
});

view = new BattleView(app, mirror, {
  onSwap: (unitAId, unitBId) => client.send({ type: 'swapPositions', unitAId, unitBId }),
  onBeginBattle: () => client.send({ type: 'beginBattle' }),
  onSubmit: (actions) => client.send({ type: 'submitCommands', actions }),
  onRestart: () => {
    // 换局会换掉战场与单位，3D 场景必须重建
    stage?.dispose();
    stage = null;
    client.send({ type: 'restart' });
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

  const { snapshot, records } = message;

  // 首次同步（或重开后）：这时才拿到战场与单位，才能把 3D 场景建起来
  if (!stage) {
    mirror.applySnapshot(snapshot);
    stage = new BattleStage(view.stageContainer, mirror, {
      onUnitPick: (unitId) => view.pickUnit(unitId),
    });
    view.attachStage(stage);
    view.refresh();
    return;
  }

  // 先在「旧状态」下把演出播完，再对齐权威快照 —— 血条才会跟着动作走，而不是先跳到位
  await stage.playRecords(records);
  mirror.applySnapshot(snapshot);
  view.refresh();
}

client.connect();
