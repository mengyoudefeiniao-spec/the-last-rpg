import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';

export type ClientStatus = 'connecting' | 'open' | 'closed';

export interface BattleClientOptions {
  /** 覆盖默认地址；默认连到同主机的战斗服端口。 */
  url?: string;
  onMessage: (message: ServerMessage) => void;
  onStatusChange?: (status: ClientStatus, detail?: string) => void;
}

/** 战斗服默认端口，与 src/server/index.ts 保持一致。 */
const DEFAULT_SERVER_PORT = 8787;

/**
 * 与服务端的一条 WebSocket 连接。
 *
 * 它只负责收发 —— 不解析语义、不碰状态、不做重试策略。
 * 消息原样交给上层，怎么处理是上层的事。
 */
export class BattleClient {
  private readonly url: string;
  private readonly onMessage: (message: ServerMessage) => void;
  private readonly onStatusChange: ((status: ClientStatus, detail?: string) => void) | undefined;

  private socket: WebSocket | null = null;
  private closedByUs = false;
  private retryTimer: number | undefined;

  constructor(options: BattleClientOptions) {
    this.url = options.url ?? defaultServerUrl();
    this.onMessage = options.onMessage;
    this.onStatusChange = options.onStatusChange;
  }

  get endpoint(): string {
    return this.url;
  }

  connect(): void {
    this.closedByUs = false;
    this.onStatusChange?.('connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.onStatusChange?.('open');
      // 连上就入局 —— 服务端会回一份初始快照
      this.send({ type: 'join' });
    });

    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      try {
        this.onMessage(JSON.parse(raw) as ServerMessage);
      } catch {
        this.onStatusChange?.('open', '收到无法解析的消息');
      }
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.closedByUs) {
        this.onStatusChange?.('closed');
        return;
      }
      this.onStatusChange?.('closed', '与战斗服的连接断开，正在重连…');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // close 事件随后就到，这里不重复处理
    });
  }

  send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.onStatusChange?.('closed', '尚未连上战斗服，操作已忽略');
      return;
    }
    socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer !== undefined) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.socket?.close();
    this.socket = null;
  }

  /** 断线后 2 秒重连一次，不搞指数退避 —— 原型阶段够用。 */
  private scheduleReconnect(): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.closedByUs) this.connect();
    }, 2000);
  }
}

function defaultServerUrl(): string {
  const configured = import.meta.env['VITE_BATTLE_SERVER'];
  if (typeof configured === 'string' && configured.length > 0) return configured;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.hostname}:${DEFAULT_SERVER_PORT}`;
}
