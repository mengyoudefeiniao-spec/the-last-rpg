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
 */

/** 行动条的节拍间隔。比渲染帧率低得多，中间的空白由客户端插值补平。 */
const TICK_MS = 100;

/**
 * 等客户端播完演出的兜底时限。
 * 客户端崩了、断线了，也不能让这场战斗永远卡在「等确认」上 —— 到点就放行。
 */
const PLAYBACK_TIMEOUT_MS = 8000;

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

  /**
   * 演出闸门。
   *
   * 服务端一产出记录就暂停推进，等客户端播完回 playbackDone。这一个开关把两件事分开了：
   * · 你选技能时条继续走（仙剑 3 那种紧张感）—— 那时没有记录要播，闸门是开的
   * · 正在演动画时条不走 —— 不然画面在演、条还在涨，玩家会看不懂发生了什么
   */
  let playbackPending = false;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
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

  /** 落下闸门：暂停推进，等客户端确认 —— 但到点自动放行，不让战斗卡死。 */
  const holdPlayback = (): void => {
    playbackPending = true;
    if (playbackTimer !== undefined) clearTimeout(playbackTimer);
    playbackTimer = setTimeout(() => {
      playbackTimer = undefined;
      playbackPending = false;
    }, PLAYBACK_TIMEOUT_MS);
  };

  /** 客户端说播完了（或者压根没连上）。 */
  const releasePlayback = (): void => {
    if (playbackTimer !== undefined) {
      clearTimeout(playbackTimer);
      playbackTimer = undefined;
    }
    playbackPending = false;
  };

  /**
   * 一次状态同步 = 先给演出剧本，再给权威状态。
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

    if (includeRecords && records.length > 0) holdPlayback();
  };

  const sendTick = (): void => {
    if (!session || session.finished) return;
    send({ type: 'tick', tick: session.tick() });
  };

  /**
   * 一个节拍：推进行动条；若产生了新记录就交给客户端去演，并落下闸门。
   * 闸门落下期间不再推进 —— 这就是「演出时暂停」。
   */
  const beat = async (): Promise<void> => {
    if (!session) return;

    if (session.finished) {
      stopTicking();
      return;
    }

    if (playbackPending) return;

    try {
      await session.advance(TICK_MS);
    } catch (error) {
      fail(error);
      return;
    }

    const records = session.takeRecords();
    if (records.length > 0) {
      send({ type: 'snapshot', snapshot: session.snapshot(), records });
      holdPlayback();
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
    if (tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    releasePlayback();
  }

  const startSession = async (seed?: number): Promise<void> => {
    const config = await readPartyConfig();
    session = BattleSession.create({ sessionId: randomUUID(), config, seed });
    releasePlayback();
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
          if (playbackPending) throw new Error('正在播放演出，请稍候');
          await requireSession().submitAction(message.unitId, message.action);
          sync();
          break;

        case 'triggerEvent':
          await requireSession().triggerEvent(message.eventId);
          sync();
          break;

        case 'playbackDone':
          releasePlayback();
          sendTick();
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
