import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { BattleSession } from './battle-session.ts';

/**
 * 战斗服。
 *
 * 职责只有两件：管住会话（唯一的权威状态所在），把状态与演出剧本推给客户端。
 * 它不做任何渲染，也不知道对面是浏览器还是测试脚本 —— 全靠 protocol.ts 那份契约。
 */

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

  const send = (message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const fail = (error: unknown): void => {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  };

  /**
   * 一次同步 = 先给演出剧本，再给权威状态。
   * includeRecords 为 false 时丢弃剧本（例如这次请求失败了，没有可演的东西）。
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

  const requireSession = (): BattleSession => {
    if (!session) throw new Error('尚未加入战斗，请先发送 join');
    return session;
  };

  const startSession = (battlefieldId?: string, seed?: number): void => {
    session = BattleSession.create({ sessionId: randomUUID(), battlefieldId, seed });
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
          startSession(message.battlefieldId, message.seed);
          sync();
          break;

        case 'swapPositions':
          requireSession().swapPositions(message.unitAId, message.unitBId);
          sync();
          break;

        case 'beginBattle':
          await requireSession().beginBattle();
          sync();
          break;

        case 'submitCommands':
          await requireSession().submitCommands(message.actions);
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

  socket.on('error', () => {
    // 连接级错误无需处理，close 事件会跟上
  });
}
