import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import { startBattleServer } from '../src/server/server.ts';

/**
 * 服务端集成测试：真起一个战斗服、真连 WebSocket。
 *
 * 这里验的不是战斗规则（那在 battle.test.ts），而是**服务端权威这条链路**：
 * 客户端只能发意图、服务端裁决后才改状态、状态与演出剧本一起下发。
 */

/**
 * 起一个只服务这次测试的战斗服。
 *
 * 端口交给系统分配；队伍配置也重定向到临时文件 ——
 * 否则跑一次测试就会把开发者本地的阵法与场景改掉（这个坑真踩过一次）。
 */
async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
  const previous = process.env['PARTY_CONFIG_PATH'];
  const configPath = join(tmpdir(), `rpg-party-config-${randomUUID()}.json`);
  process.env['PARTY_CONFIG_PATH'] = configPath;

  const server = await startBattleServer({ port: 0 });
  try {
    return await run(server.url);
  } finally {
    await server.close();
    await rm(configPath, { force: true });
    if (previous === undefined) delete process.env['PARTY_CONFIG_PATH'];
    else process.env['PARTY_CONFIG_PATH'] = previous;
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

  /**
   * 取下一条指定类型的消息，途中的其它消息直接丢掉。
   * 开战后服务端每 100ms 就推一条行动条心跳，所以不能假设「下一条就是我要的」。
   */
  async nextOfType<T extends ServerMessage['type']>(
    type: T,
    guard = 400,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (let i = 0; i < guard; i += 1) {
      const message = await this.next();
      if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    throw new Error(`等了 ${guard} 条消息也没等到 ${type}`);
  }

  /** 取一条快照。 */
  nextSnapshot(): Promise<Extract<ServerMessage, { type: 'snapshot' }>> {
    return this.nextOfType('snapshot');
  }

  /** 一直等，直到服务端说「有人能行动了」，返回那批单位 id。 */
  async waitForReadyUnit(guard = 400): Promise<string[]> {
    for (let i = 0; i < guard; i += 1) {
      const message = await this.next();
      const awaiting =
        message.type === 'tick'
          ? message.tick.awaitingUnitIds
          : message.type === 'snapshot'
            ? message.snapshot.awaitingUnitIds
            : [];
      if (awaiting.length > 0) return awaiting;
    }
    return [];
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

test('队伍配置是战斗外的设定：改了会按新配置重开一局', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      const before = await client.nextSnapshot();

      client.send({
        type: 'savePartyConfig',
        formationId: 'square-circle',
        environmentId: 'frost-peak',
        weatherId: 'snowfall',
      });
      const after = await client.nextSnapshot();

      assert.notEqual(after.snapshot.sessionId, before.snapshot.sessionId, '应当换了一局');
      assert.equal(after.snapshot.phase, 'deployment', '重开后回到布阵阶段');
      assert.equal(after.snapshot.formation.id, 'square-circle', '阵法应当生效');
      assert.equal(after.snapshot.scenery.environment.id, 'frost-peak', '环境应当生效');
      assert.equal(after.snapshot.scenery.weather.id, 'snowfall', '天气应当生效');

      // 站位应当跟着新阵法走 —— 阵法定站位，客户端改不了
      const allyPositions = after.snapshot.units
        .filter((unit) => unit.side === 'ally')
        .map((unit) => `${unit.position.x},${unit.position.z}`);
      const expected = after.snapshot.formation.slots.map((slot) => `${slot.x},${slot.z}`);
      assert.deepEqual(allyPositions, expected, '我方站位应当与新阵法一致');
    } finally {
      client.close();
    }
  });
});

test('协议里已经没有「战斗中换位」这条旁路', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      // 站位只由阵法决定，客户端不该有别的路子挪人
      client.send({ type: 'swapPositions', unitAId: 'a', unitBId: 'b' } as never);
      const denied = await client.next();
      assert.equal(denied.type, 'error', '未知意图必须被拒绝');
    } finally {
      client.close();
    }
  });
});

test('剧情事件从上方降临：服务端结算并下发演出记录', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      const welcome = await client.nextSnapshot();

      const hpBefore = new Map(welcome.snapshot.units.map((unit) => [unit.id, unit.stats.hp]));

      client.send({ type: 'triggerEvent', eventId: 'thunder' });
      const message = await client.nextSnapshot();

      const eventRecord = message.records.find((record) => record.kind === 'stageEvent');
      assert.ok(eventRecord, '应当有剧情事件的演出记录');
      if (eventRecord?.kind === 'stageEvent') {
        assert.equal(eventRecord.eventId, 'thunder');
        assert.ok(eventRecord.anchor.y > 0, '演出锚点应当在战场上方（事件区）');
      }

      for (const unit of message.snapshot.units) {
        const before = hpBefore.get(unit.id) ?? 0;
        assert.ok(unit.stats.hp < before, `${unit.name} 应当被天雷劈中而掉血`);
      }

      // 未知事件必须被拒绝
      client.send({ type: 'triggerEvent', eventId: '不存在的事件' });
      const denied = await client.nextOfType('error');
      assert.match(denied.message, /事件/, '报错应当说明是哪个事件不认识');
    } finally {
      client.close();
    }
  });
});

test('开战后进入交战，全场行动值从零开始', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      client.send({ type: 'beginBattle' });
      const { snapshot, records } = await client.nextSnapshot();

      assert.equal(snapshot.phase, 'battle', '开战后进入交战阶段');
      assert.equal(snapshot.round, 1, '应当进入第 1 轮');
      assert.ok(
        records.some((record) => record.kind === 'roundStart'),
        '应当有轮次开始的演出记录',
      );
      assert.ok(
        records.some((record) => record.kind === 'status'),
        '雪山战场应当因地形成功施加了状态记录',
      );
      assert.ok(
        snapshot.units.every((unit) => unit.gauge === 0),
        '开局所有人的行动值都该是空的 —— 谁先到点全看速度',
      );
      assert.ok(
        snapshot.units.every((unit) => unit.gaugePerSecond > 0),
        '每个单位都该带上自己的行动条推进速度，客户端靠它插值',
      );
    } finally {
      client.close();
    }
  });
});

test('服务端推行动条，条满才轮到人 —— 此时才能下达指令', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      client.send({ type: 'beginBattle' });
      await client.nextSnapshot();

      // 等行动条走到有人能动。这一步本身就验证了「服务端在推进」
      const awaiting = await client.waitForReadyUnit();
      assert.ok(awaiting.length > 0, '服务端应当把行动条推到有人能动');

      const unitId = awaiting[0];
      assert.ok(unitId);

      const before = await client.nextSnapshot();
      const unit = before.snapshot.units.find((u) => u.id === unitId);
      assert.ok(unit, '等着指令的单位应当在场上');
      assert.ok(unit.gauge >= 100, '能动就意味着条满了');
      assert.equal(unit.awaitingCommand, true, '条满的单位应当挂上等待标记');

      const enemy = before.snapshot.units.find((u) => u.side === 'enemy' && u.alive);
      assert.ok(enemy, '应当有活着的敌人');

      client.send({
        type: 'act',
        unitId,
        action: { actorId: unitId, commandId: 'attack', targetId: enemy.id },
      });

      const advanced = await client.nextSnapshot();

      assert.ok(
        advanced.records.some((record) => record.kind === 'strike'),
        '出手了就该有受击记录',
      );
      assert.ok(
        advanced.records.every((record) => record.kind !== 'strike' || record.hpAfter >= 0),
        '受击记录应当带上结算后的血量',
      );

      const damaged = advanced.snapshot.units.find((u) => u.id === enemy.id);
      assert.ok(damaged, '应当还能找到那个敌人');
      assert.ok(
        damaged.stats.hp < enemy.stats.hp,
        '被打的目标应当掉血 —— 而且这个结果只可能来自服务端',
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

      // 还在布阵就想出手 —— 阶段不对，必须被拒
      client.send({
        type: 'act',
        unitId: 'anyone',
        action: { actorId: 'anyone', commandId: 'attack' },
      });
      const denied = await client.nextOfType('error');
      assert.match(denied.message, /deployment/, '报错应当说明当前阶段');

      // 没入局就操作 —— 也必须被拒
      const fresh = await TestClient.connect(url);
      try {
        fresh.send({ type: 'beginBattle' });
        const notJoined = await fresh.nextOfType('error');
        assert.match(notJoined.message, /join/, '应当提醒先 join');
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
      assert.equal(second.snapshot.round, 0);
    } finally {
      client.close();
    }
  });
});

test('演出播放期间行动条照常推进 —— 服务端不等客户端确认', async () => {
  await withServer(async (url) => {
    const client = await TestClient.connect(url);
    try {
      client.send({ type: 'join' });
      await client.nextSnapshot();

      client.send({ type: 'beginBattle' });
      await client.nextSnapshot();

      const awaiting = await client.waitForReadyUnit();
      assert.ok(awaiting.length > 0, '应当有人能行动');

      // 关键：从这一刻起**一个消息都不发**。
      // 如果服务端在等「客户端播完演出」的确认，这里就再也收不到东西了 —— 行动条会僵住。
      const received: string[] = [];
      const startAt = Date.now();
      while (Date.now() - startAt < 2000 && received.length < 6) {
        const message = await client.next();
        received.push(message.type);
      }

      assert.ok(
        received.length >= 4,
        `静等 2 秒只收到 ${received.length} 条消息（${received.join(',')}）—— 服务端在等确认，行动条被卡住了`,
      );
    } finally {
      client.close();
    }
  });
});
