import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { BattleSession } from './battle-session.ts';
import { readPartyConfig, writePartyConfig } from './party-config.ts';

/**
 * 战斗服。
 *
 * 职责三件：管住会话（唯一的权威状态所在）、按节拍推进行动条、把状态与演出剧本推给客户端。
 * 它不做任何渲染，也不知道对面是浏览器还是测试脚本 —— 全靠 protocol.ts 那份契约。
 *
 * 注意**推进与播放是解耦的**：服务端不等客户端把演出播完。
 * 行动条在别人动手的时候照常走 —— 那种压迫感正是实时行动条的意义所在。
 */

/** 行动条的节拍间隔。比渲染帧率低得多，中间的空白由客户端插值补平。 */
const TICK_MS = 100;

export interface BattleServerOptions {
  port?: number;
  host?: string;
}

export interface BattleServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startBattleServer(options: BattleServerOptions = {}): Promise<BattleServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;

  const http = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('战斗服只提供 WebSocket（/）与健康检查（/health）');
  });

  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => handleConnection(socket));

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const address = http.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: actualPort,
    url: `ws://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 先掐断现有连接，否则 close 会一直等客户端自己走
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          http.close((error) => (error ? reject(error) : resolve()));
        });
      }),
  };
}

function handleConnection(socket: WebSocket): void {
  /** 这条连接对应的会话句柄 —— 权威状态在服务端，客户端手里只是投影。 */
  let session: BattleSession | null = null;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  const send = (message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const fail = (error: unknown): void => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  };

  const requireSession = (): BattleSession => {
    if (!session) throw new Error('尚未加入战斗，请先发送 join');
    return session;
  };

  /**
   * 一次状态同步 = 演出剧本 + 权威状态。
   * 剧本只是「怎么演」，客户端播不完也不影响推进 —— 它自己会排在队列里播。
   */
  const sync = (includeRecords = true): void => {
    if (!session) return;

    const records = session.takeRecords();
    send({
      type: 'snapshot',
      snapshot: session.snapshot(),
      records: includeRecords ? records : [],
    });
  };

  const sendTick = (): void => {
    if (!session || session.finished) return;
    send({ type: 'tick', tick: session.tick() });
  };

  /** 一个节拍：推进行动条；有新记录就顺带给客户端去演。 */
  const beat = async (): Promise<void> => {
    if (!session) return;

    if (session.finished) {
      stopTicking();
      return;
    }

    try {
      await session.advance(TICK_MS);
    } catch (error) {
      fail(error);
      return;
    }

    const records = session.takeRecords();
    if (records.length > 0) {
      send({ type: 'snapshot', snapshot: session.snapshot(), records });
      return;
    }

    sendTick();
  };

  function startTicking(): void {
    if (tickTimer !== undefined) return;
    tickTimer = setInterval(() => {
      void beat();
    }, TICK_MS);
  }

  function stopTicking(): void {
    if (tickTimer === undefined) return;
    clearInterval(tickTimer);
    tickTimer = undefined;
  }

  const startSession = async (seed?: number): Promise<void> => {
    const config = await readPartyConfig();
    session = BattleSession.create({ sessionId: randomUUID(), config, seed });
  };

  const handle = async (raw: string): Promise<void> => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      send({ type: 'error', message: '消息不是合法 JSON' });
      return;
    }

    try {
      switch (message.type) {
        case 'join':
        case 'restart':
          await startSession(message.seed);
          sync();
          startTicking();
          break;

        case 'savePartyConfig':
          // 阵法与场景是战斗外的设定，改了等于换一场仗 —— 所以保存之后直接重开一局
          stopTicking();
          await writePartyConfig({
            formationId: message.formationId,
            battlefieldId: message.battlefieldId,
            environmentId: message.environmentId,
            weatherId: message.weatherId,
          });
          await startSession();
          sync();
          startTicking();
          break;

        case 'beginBattle':
          await requireSession().beginBattle();
          sync();
          startTicking();
          break;

        case 'act':
          await requireSession().submitAction(message.unitId, message.action);
          sync();
          break;

        case 'triggerEvent':
          await requireSession().triggerEvent(message.eventId);
          sync();
          break;

        default: {
          const unknown: never = message;
          send({ type: 'error', message: `未知的消息类型：${JSON.stringify(unknown)}` });
        }
      }
    } catch (error) {
      fail(error);
      // 出错也要把权威状态推回去，否则客户端界面会停在半截
      sync(false);
    }
  };

  socket.on('message', (data) => {
    void handle(data.toString());
  });

  socket.on('close', () => {
    stopTicking();
  });

  socket.on('error', () => {
    // 连接级错误无需处理，close 事件会跟上
  });
}
