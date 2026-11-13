// Real-time hub: browser sessions on one side, local bridges on the other.
// Requests to a bridge are correlated by id; bridge events update card metadata and are
// fanned out to the owner's browser sessions. Logs and diffs pass through in memory only.

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  BridgeError,
  BridgeInfo,
  BridgeMethod,
  BridgeMethods,
  BridgeToServer,
  CardStatePatch,
  ServerToWeb,
  Card,
  NotifyKind,
} from '@localkan/protocol';
import { cardEvent } from './push.ts';
import { type Store, toDevice } from './store.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: BridgeRequestError) => void;
  timer: NodeJS.Timeout;
}

interface BridgeConn {
  deviceId: string;
  userId: string;
  socket: WebSocket;
  pending: Map<string, Pending>;
}

export class BridgeRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class Hub {
  private readonly store: Store;
  private readonly web = new Map<string, Set<WebSocket>>();
  private readonly bridges = new Map<string, BridgeConn>();

  private readonly onCardEvent?: (userId: string, kind: NotifyKind, card: Card) => void;

  constructor(store: Store, opts: { onCardEvent?: (userId: string, kind: NotifyKind, card: Card) => void } = {}) {
    this.store = store;
    this.onCardEvent = opts.onCardEvent;
  }

  // -- browser sessions ----------------------------------------------------

  addWebClient(userId: string, socket: WebSocket) {
    let set = this.web.get(userId);
    if (!set) this.web.set(userId, (set = new Set()));
    set.add(socket);
    socket.on('close', () => set.delete(socket));
  }

  sendToUser(userId: string, msg: ServerToWeb) {
    const data = JSON.stringify(msg);
    for (const s of this.web.get(userId) ?? []) {
      if (s.readyState === s.OPEN) s.send(data);
    }
  }

  // -- bridges -------------------------------------------------------------

  isOnline(deviceId: string): boolean {
    return this.bridges.has(deviceId);
  }

  addBridge(deviceId: string, userId: string, socket: WebSocket) {
    // A device keeps one live connection; a reconnect replaces the old one.
    this.bridges.get(deviceId)?.socket.close(4000, 'replaced');
    const conn: BridgeConn = { deviceId, userId, socket, pending: new Map() };
    this.bridges.set(deviceId, conn);
    void this.touchDevice(deviceId);
    void this.adoptOrphans(userId, deviceId);

    socket.on('message', (raw) => {
      let msg: BridgeToServer;
      try {
        msg = JSON.parse(String(raw)) as BridgeToServer;
      } catch {
        return;
      }
      this.onBridgeMessage(conn, msg).catch((err) => console.error('bridge message:', err));
    });
    socket.on('close', () => {
      if (this.bridges.get(deviceId) !== conn) return;
      this.bridges.delete(deviceId);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new BridgeRequestError('bridge_offline', 'Máy chạy bridge vừa ngắt kết nối.'));
      }
      void this.touchDevice(deviceId);
    });
  }

  /** Boards left on a removed device follow the computer that connects next. */
  private async adoptOrphans(userId: string, deviceId: string) {
    try {
      const moved = await this.store.adoptOrphanProjects(userId, deviceId);
      for (const id of moved) {
        const project = await this.store.getProject(id);
        if (project) this.sendToUser(userId, { type: 'project.updated', project });
      }
      if (moved.length) console.log(`moved ${moved.length} board(s) from a removed device to ${deviceId}`);
    } catch (err) {
      console.error('adopt boards:', (err as Error).message);
    }
  }

  request<M extends BridgeMethod>(
    deviceId: string,
    method: M,
    params: BridgeMethods[M]['params'],
    timeoutMs = 30_000,
  ): Promise<BridgeMethods[M]['result']> {
    const conn = this.bridges.get(deviceId);
    if (!conn) {
      return Promise.reject(
        new BridgeRequestError('bridge_offline', 'Máy chạy bridge đang offline. Hãy mở Localkan Bridge trên máy đó.'),
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new BridgeRequestError('timeout', `Bridge không phản hồi lệnh ${method} sau ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      conn.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      conn.socket.send(JSON.stringify({ kind: 'req', id, method, params }));
    });
  }

  private async onBridgeMessage(conn: BridgeConn, msg: BridgeToServer) {
    if (msg.kind === 'res') {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = msg.error as BridgeError;
        p.reject(new BridgeRequestError(err.code, err.message));
      }
      return;
    }
    if (msg.kind !== 'event') return;
    switch (msg.event) {
      case 'hello':
        await this.onHello(conn, msg.data);
        break;
      case 'card.state':
        await this.onCardState(conn, msg.data);
        break;
      case 'project.preview': {
        const project = await this.store.getProject(msg.data.projectId);
        // A bridge may only report on boards that live on its own device.
        if (!project || project.deviceId !== conn.deviceId) return;
        await this.store.updateProject(project.id, { preview: msg.data.preview });
        this.sendToUser(conn.userId, { type: 'project.updated', project: { ...project, preview: msg.data.preview } });
        break;
      }
      case 'card.log': {
        const owner = await this.store.cardOwner(msg.data.cardId);
        if (!owner || owner.deviceId !== conn.deviceId) return;
        this.sendToUser(conn.userId, { type: 'card.log', cardId: msg.data.cardId, lines: msg.data.lines });
        break;
      }
    }
  }

  private async onHello(conn: BridgeConn, info: BridgeInfo) {
    await this.store.setDeviceInfo(conn.deviceId, info);
    await this.broadcastDevice(conn.deviceId);
  }

  private async onCardState(conn: BridgeConn, patch: CardStatePatch) {
    const owned = await this.store.getCardWithOwner(patch.cardId);
    // A bridge may only update cards that live on its own device.
    if (!owned || owned.deviceId !== conn.deviceId) return;
    // Finished cards are final: a bridge re-syncing old state must not reopen them.
    if (owned.card.status === 'done') return;
    const { cardId, ...rest } = patch;
    const card = await this.store.updateCard(cardId, rest);
    if (card) this.sendToUser(owned.userId, { type: 'card.updated', card });
    // Notifications: done, needs you, failed (only on the transition, not on re-syncs).
    const event = card ? cardEvent(owned.card, card) : null;
    if (card && event) this.onCardEvent?.(owned.userId, event, card);
    // "Preview when done": start it the moment the agent reports success, so the phone link
    // is ready by the time you open the card.
    const justFinished = owned.card.status !== 'review' && rest.status === 'review' && rest.runState === 'succeeded';
    if (card && justFinished && card.autoPreview && !card.preview && card.worktreePath) {
      this.request(conn.deviceId, 'card.preview.start', { cardId, tunnel: true }, 900_000).catch((err) =>
        console.error('auto preview:', (err as Error).message),
      );
    }
  }

  private async touchDevice(deviceId: string) {
    try {
      await this.store.touchDevice(deviceId);
      await this.broadcastDevice(deviceId);
    } catch (err) {
      console.error('touch device:', err);
    }
  }

  async broadcastDevice(deviceId: string) {
    const d = await this.store.getDevice(deviceId);
    if (!d) return;
    this.sendToUser(d.userId, { type: 'device.updated', device: toDevice(d, this.isOnline(deviceId)) });
  }

  disconnectDevice(deviceId: string) {
    this.bridges.get(deviceId)?.socket.close(4001, 'revoked');
  }
}
