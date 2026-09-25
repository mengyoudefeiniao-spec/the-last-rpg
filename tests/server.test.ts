import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import { startBattleServer } from '../src/server/server.ts';

/**
 * 服务端集成测试：真起一个战斗服、真连 WebSocket。
 *
 * 这里验的不是战斗规则（那在 battle.test.ts），而是**服务端权威这条链路**：
 * 客户端只能发意图、服务端裁决后才改状态、状态与演出剧本一起下发。
 */

/** 起一个只服务这次测试的战斗服，端口交给系统分配。 */
async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
  const server = await startBattleServer({ port: 0 });
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

/** 极简测试客户端：发消息、按顺序取回消息。 */
class TestClient {
  private readonly socket: WebSocket;
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Array<(message: ServerMessage) => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      const waiter = client.waiters.shift();
      if (waiter) waiter(message);
      else client.queue.push(message);
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`连不上 ${url}`)), {
        once: true,
      });
    });

    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** 取下一条消息；没有则等着。 */
  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 取一条快照，顺便断言类型。 */
  async nextSnapshot(): Promise<Extract<ServerMessage, { type: 'snapshot' }>> {
    const message = await this.next();
    assert.equal(message.type, 'snapshot', `期望快照，实际收到 ${message.type}`);
    return message as Extract<ServerMessage, { type: 'snapshot' }>;
  }

  close(): void {
    this.socket.close();
  }
}

test('连上并入局后拿到初始快照，且停在布阵阶段', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      const { snapshot, records } = await client.nextSnapshot();

      assert.equal(snapshot.phase, 'deployment', '开局应当停在布阵阶段');
      assert.equal(snapshot.units.length, 10, '应当是 5v5');
      assert.ok(snapshot.battlefield.zones.length > 0, '应当把地形分区一起下发');
      assert.equal(snapshot.awaitingUnitIds.length, 0, '布阵阶段不该有指令要下');
      assert.equal(records.length, 0, '首次同步不该带演出记录');
      assert.ok(snapshot.units.every((unit) => unit.alive), '开局应当全员存活');
    } finally {
      client.close();
    }
  });
});

test('服务端裁决换位：坐标真的换了，且只限我方', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      const welcome = await client.nextSnapshot();

      const allies = welcome.snapshot.units.filter((unit) => unit.side === 'ally');
      const first = allies[0];
      const second = allies[1];
      assert.ok(first && second, '应当至少有两位我方单位');

      client.send({ type: 'swapPositions', unitAId: first.id, unitBId: second.id });
      const { snapshot } = await client.nextSnapshot();

      const movedFirst = snapshot.units.find((unit) => unit.id === first.id);
      const movedSecond = snapshot.units.find((unit) => unit.id === second.id);
      assert.deepEqual(movedFirst?.position, second.position, '甲应当搬到乙原来的位置');
      assert.deepEqual(movedSecond?.position, first.position, '乙应当搬到甲原来的位置');

      // 拿敌人来换 —— 服务端必须拒绝
      const enemy = snapshot.units.find((unit) => unit.side === 'enemy');
      assert.ok(enemy);
      client.send({ type: 'swapPositions', unitAId: first.id, unitBId: enemy.id });

      const denied = await client.next();
      assert.equal(denied.type, 'error', '不该允许把敌人拖来拖去');
    } finally {
      client.close();
    }
  });
});

test('开战后服务端下发回合开始记录与待指令列表', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      client.send({ type: 'beginBattle' });
      const { snapshot, records } = await client.nextSnapshot();

      assert.equal(snapshot.phase, 'commandInput', '开战后应当等玩家下指令');
      assert.equal(snapshot.turn, 1, '应当进入第 1 回合');
      assert.equal(snapshot.awaitingUnitIds.length, 5, '我方 5 人都该等指令');
      assert.ok(
        records.some((record) => record.kind === 'turnStart'),
        '应当有回合开始的演出记录',
      );
      assert.ok(
        records.some((record) => record.kind === 'status'),
        '雪山战场应当因地形成功施加了状态记录',
      );
    } finally {
      client.close();
    }
  });
});

test('提交一整回合指令，服务端算完再回状态与演出剧本', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      client.send({ type: 'beginBattle' });
      const started = await client.nextSnapshot();

      const enemy = started.snapshot.units.find((unit) => unit.side === 'enemy' && unit.alive);
      assert.ok(enemy, '应当有活着的敌人');

      const actions = started.snapshot.awaitingUnitIds.map((actorId) => ({
        actorId,
        commandId: 'attack' as const,
        targetId: enemy.id,
      }));

      client.send({ type: 'submitCommands', actions });
      const advanced = await client.nextSnapshot();

      assert.ok(
        advanced.records.some((record) => record.kind === 'strike'),
        '一回合打完应当产生受击记录',
      );
      assert.ok(
        advanced.records.every((record) => record.kind !== 'strike' || record.hpAfter >= 0),
        '受击记录应当带上结算后的血量',
      );

      const damaged = advanced.snapshot.units.find((unit) => unit.id === enemy.id);
      assert.ok(damaged, '应当还能找到那个敌人');
      assert.ok(
        damaged.stats.hp < enemy.stats.hp,
        '被打了 5 次，血量应当下降 —— 而且这个结果只可能来自服务端',
      );
    } finally {
      client.close();
    }
  });
});

test('非法意图被拒绝，客户端绕不过服务端', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      // 布阵阶段就提交指令 —— 阶段不对，必须被拒
      client.send({ type: 'submitCommands', actions: [] });
      const denied = await client.next();
      assert.equal(denied.type, 'error');
      if (denied.type === 'error') {
        assert.match(denied.message, /deployment/, '报错应当说明当前阶段');
      }

      // 没入局就操作 —— 也必须被拒
      const fresh = await TestClient.connect(url);
      try {
        fresh.send({ type: 'beginBattle' });
        const notJoined = await fresh.next();
        assert.equal(notJoined.type, 'error');
      } finally {
        fresh.close();
      }
    } finally {
      client.close();
    }
  });
});

test('重开一局会换一个新的 sessionId', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      const first = await client.nextSnapshot();

      client.send({ type: 'restart' });
      const second = await client.nextSnapshot();

      assert.notEqual(first.snapshot.sessionId, second.snapshot.sessionId);
      assert.equal(second.snapshot.phase, 'deployment');
      assert.equal(second.snapshot.turn, 0);
    } finally {
      client.close();
    }
  });
});
