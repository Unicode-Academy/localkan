// Localkan cloud layer: REST API + WebSocket hub for browsers and local bridges.
//
//   DATABASE_URL  MongoDB connection string (required), e.g. mongodb+srv://user:pass@host/db
//   DATABASE_NAME override the database named in DATABASE_URL (optional)
//   PORT          HTTP port (default 8787)
//   HOST          bind address (default 127.0.0.1; set 0.0.0.0 to expose)
//   DATA_DIR      where card images are stored (default ./.data)
//   WEB_DIST      built web UI to serve (default ../web/dist when present)
//   SECURE_COOKIES=1 when served over HTTPS
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  Web Push keys (optional, see push.ts)

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { createApi, deviceForToken, SESSION_COOKIE, sessionUserId } from './api.ts';
import { Hub } from './hub.ts';
import { cardPayload, eventKind, Push } from './push.ts';
import { Store } from './store.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = resolve(process.env.DATA_DIR ?? '.data');
const WEB_DIST = resolve(process.env.WEB_DIST ?? '../web/dist');

if (!process.env.DATABASE_URL) {
  console.error('Thiếu DATABASE_URL (chuỗi kết nối MongoDB). Đặt nó trong apps/server/.env.');
  process.exit(1);
}
const store = await Store.connect(process.env.DATABASE_URL, process.env.DATABASE_NAME || undefined).catch((err: Error) => {
  console.error(`Không kết nối được MongoDB: ${err.message}`);
  process.exit(1);
});
console.log(`MongoDB connected (database: ${store.db.databaseName})`);
const push = await Push.init(store.db);
const hub = new Hub(store, {
  // Push "done / needs you / failed" to the user's devices.
  onCardEvent: (userId, event, card) => {
    store
      .getProject(card.projectId)
      .then((p) => push.notify(userId, eventKind(event), cardPayload(event, card, p?.name ?? 'Localkan')))
      .catch((err: Error) => console.error('notify:', err.message));
  },
});

const app = new Hono();
app.route('/api', createApi(store, hub, { secureCookies: process.env.SECURE_COOKIES === '1', dataDir: DATA_DIR, push }));
app.get('/healthz', (c) => c.json({ ok: true }));

if (existsSync(WEB_DIST)) {
  app.use('/*', serveStatic({ root: WEB_DIST }));
  // Single-page app: unknown paths fall back to index.html.
  app.get('*', serveStatic({ root: WEB_DIST, path: 'index.html' }));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Localkan server listening on http://${info.address}:${info.port}`);
  if (!existsSync(WEB_DIST)) {
    // In Docker the web UI is its own container (Caddy); in development Vite serves it.
    console.log(process.env.WEB_DIST ? '(web UI served separately)' : '(web UI not built; run the Vite dev server: pnpm dev:web)');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const reject = (code: number, msg: string) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  // Everything lives under /api so a reverse proxy needs one rule; the old /ws and /bridge
  // paths keep working for bridges and pages from before.
  if (url.pathname === '/api/ws' || url.pathname === '/ws') {
    const userId = await sessionUserId(store, cookieValue(req, SESSION_COOKIE)).catch(() => null);
    if (!userId) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => hub.addWebClient(userId, ws));
    return;
  }

  if (url.pathname === '/api/bridge' || url.pathname === '/bridge') {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const device = await deviceForToken(store, token).catch(() => null);
    if (!device) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => hub.addBridge(device.id, device.userId, ws));
    return;
  }

  reject(404, 'Not Found');
});

// Keep idle connections (proxies, laptops) from being dropped silently.
setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
}, 25_000).unref();

// Close the MongoDB connection cleanly on Ctrl-C / restarts.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    server.close();
    store.close().finally(() => process.exit(0));
  });
}
