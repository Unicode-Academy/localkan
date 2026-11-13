import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  AGENTS,
  ATTACHMENT_LIMITS,
  type AgentId,
  type Card,
  type CardMode,
  type FinishAction,
  type ReviewComment,
  type TerminalKey,
  type BrowserAction,
  type NotifyPrefs,
  type PushSubscriptionJSON,
  type GitSettings,
  DEFAULT_GIT_SETTINGS,
} from '@localkan/protocol';
import { hashPassword, newPairingCode, newToken, normalizePairingCode, sha256, verifyPassword } from './auth.ts';
import { BridgeRequestError, type Hub } from './hub.ts';
import { type Push, PushError } from './push.ts';
import { type CardPatch, type Store, toDevice } from './store.ts';

export const SESSION_COOKIE = 'lk_session';
const SESSION_DAYS = 30;
const BROWSER_KINDS = new Set<string>(['tabs', 'open', 'shot', 'goto', 'tap', 'type', 'key', 'scroll', 'back', 'reload', 'close', 'login']);
const PAIRING_MINUTES = 10;

type Env = { Variables: { userId: string } };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sessionUserId(store: Store, token: string | undefined): Promise<string | null> {
  return token ? store.sessionUser(sha256(token)) : Promise.resolve(null);
}

export function deviceForToken(store: Store, token: string | undefined): Promise<{ id: string; userId: string } | null> {
  return token ? store.deviceForTokenHash(sha256(token)) : Promise.resolve(null);
}

export function createApi(store: Store, hub: Hub, opts: { secureCookies: boolean; dataDir: string; push: Push }) {
  const api = new Hono<Env>();
  // Card images live on disk under DATA_DIR: <dataDir>/attachments/<cardId>/<attachmentId>.
  const attachmentDir = (cardId: string) => join(opts.dataDir, 'attachments', cardId);
  const attachmentFile = (cardId: string, id: string) => join(attachmentDir(cardId), id);
  const sendFile = (cardId: string, a: { id: string; name: string; mime: string }) =>
    new Response(readFileSync(attachmentFile(cardId, a.id)), {
      headers: {
        'content-type': a.mime,
        'cache-control': 'private, max-age=3600',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      },
    });

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof PushError) return c.json({ error: err.message }, 400);
    if (err instanceof BridgeRequestError) return c.json({ error: err.message, code: err.code }, 502);
    console.error(err);
    return c.json({ error: 'Lỗi máy chủ.' }, 500);
  });

  const body = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new HttpError(400, 'Dữ liệu gửi lên không phải JSON hợp lệ.');
    }
  };

  const startSession = async (c: Context, userId: string) => {
    const token = newToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await store.createSession(sha256(token), userId, expires);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      // Behind the Docker web proxy (Caddy) a request over HTTPS arrives as plain HTTP with
      // X-Forwarded-Proto: https; mark the cookie Secure then too.
      secure: opts.secureCookies || c.req.header('x-forwarded-proto') === 'https',
      path: '/',
      expires,
    });
  };

  // -- public auth routes --------------------------------------------------

  api.get('/auth/state', async (c) => {
    const users = await store.countUsers();
    const userId = await sessionUserId(store, getCookie(c, SESSION_COOKIE));
    const user = userId ? await store.findUser(userId) : null;
    return c.json({ needsSetup: users === 0, user: user ? { id: user._id, email: user.email } : null });
  });

  api.post('/auth/setup', async (c) => {
    const { email, password } = await body<{ email?: string; password?: string }>(c);
    if ((await store.countUsers()) > 0) throw new HttpError(403, 'Tài khoản đầu tiên đã được tạo. Hãy đăng nhập.');
    if (!email?.includes('@') || !password || password.length < 8)
      throw new HttpError(400, 'Cần email hợp lệ và mật khẩu ít nhất 8 ký tự.');
    const id = randomUUID();
    await store.createUser(id, email.trim().toLowerCase(), hashPassword(password));
    await startSession(c, id);
    return c.json({ ok: true });
  });

  api.post('/auth/login', async (c) => {
    const { email, password } = await body<{ email?: string; password?: string }>(c);
    const u = await store.findUserByEmail(String(email ?? '').trim().toLowerCase());
    if (!u || !password || !verifyPassword(password, u.passwordHash)) throw new HttpError(401, 'Email hoặc mật khẩu không đúng.');
    await startSession(c, u._id);
    return c.json({ ok: true });
  });

  api.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await store.deleteSession(sha256(token));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // The bridge exchanges a one-time pairing code for a long-lived device token.
  api.post('/bridge/pair', async (c) => {
    const { code, deviceName } = await body<{ code?: string; deviceName?: string }>(c);
    const userId = await store.takePairingCode(normalizePairingCode(String(code ?? '')));
    if (!userId) throw new HttpError(400, 'Mã ghép nối không đúng hoặc đã hết hạn.');
    const id = randomUUID();
    const token = newToken();
    await store.createDevice(id, userId, String(deviceName || 'Máy của tôi').slice(0, 80), sha256(token));
    await hub.broadcastDevice(id);
    return c.json({ deviceId: id, token });
  });

  // The bridge downloads a card's images with its device token when the card starts.
  api.get('/bridge/attachments/:id', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const device = await deviceForToken(store, auth.startsWith('Bearer ') ? auth.slice(7) : undefined);
    if (!device) throw new HttpError(401, 'Thiết bị không hợp lệ.');
    const found = await store.findAttachment(c.req.param('id'));
    if (!found || found.deviceId !== device.id) throw new HttpError(404, 'Không tìm thấy ảnh.');
    return sendFile(found.cardId, found.attachment);
  });

  // Health check for proxies and Docker (no session needed).
  api.get('/healthz', (c) => c.json({ ok: true }));

  // -- everything below needs a browser session ----------------------------

  api.use('*', async (c, next) => {
    const userId = await sessionUserId(store, getCookie(c, SESSION_COOKIE));
    if (!userId) throw new HttpError(401, 'Bạn cần đăng nhập.');
    c.set('userId', userId);
    await next();
  });

  const ownProject = async (c: Context<Env>, id: string) => {
    const p = await store.getProject(id, c.get('userId'));
    if (!p) throw new HttpError(404, 'Không tìm thấy bảng.');
    return p;
  };

  const ownCard = async (c: Context<Env>, id: string) => {
    const owned = await store.getCardWithOwner(id);
    if (!owned || owned.userId !== c.get('userId')) throw new HttpError(404, 'Không tìm thấy thẻ.');
    return owned;
  };

  const pushCard = (userId: string, card: Card | null) => {
    if (card) hub.sendToUser(userId, { type: 'card.updated', card });
    return card;
  };

  // Devices ------------------------------------------------------------------

  api.get('/devices', async (c) => {
    const devices = await store.listDevices(c.get('userId'));
    return c.json(devices.map((d) => toDevice(d, hub.isOnline(d._id))));
  });

  api.post('/devices/pairing-code', async (c) => {
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000);
    await store.createPairingCode(code, c.get('userId'), expiresAt);
    return c.json({ code, expiresAt: expiresAt.toISOString() });
  });

  const ownDevice = async (c: Context<Env>, id: string) => {
    if (!(await store.ownsDevice(c.get('userId'), id))) throw new HttpError(404, 'Không tìm thấy máy.');
    return id;
  };

  // Opens the native folder picker on the bridge machine; waits while the user chooses.
  api.post('/devices/:id/pick-folder', async (c) => {
    const deviceId = await ownDevice(c, c.req.param('id'));
    const b = await body<{ startPath?: string }>(c).catch(() => ({}) as { startPath?: string });
    return c.json(
      await hub.request(deviceId, 'fs.pickFolder', { prompt: 'Chọn thư mục dự án cho Localkan', startPath: b.startPath }, 300_000),
    );
  });

  api.post('/devices/:id/inspect-folder', async (c) => {
    const deviceId = await ownDevice(c, c.req.param('id'));
    const { path } = await body<{ path?: string }>(c);
    if (!path?.trim()) throw new HttpError(400, 'Cần đường dẫn thư mục.');
    return c.json(await hub.request(deviceId, 'fs.inspect', { path: path.trim() }));
  });

  api.delete('/devices/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await store.deleteDevice(c.get('userId'), id))) throw new HttpError(404, 'Không tìm thấy máy.');
    hub.disconnectDevice(id);
    return c.json({ ok: true });
  });

  // Projects (boards) -------------------------------------------------------

  api.get('/projects', async (c) => c.json(await store.listProjects(c.get('userId'))));

  const registerProject = async (userId: string, projectId: string, deviceId: string, repoPath: string) => {
    try {
      const res = await hub.request(deviceId, 'project.register', { projectId, repoPath }, 90_000);
      await store.updateProject(projectId, { status: 'ready', baseRef: res.baseRef, error: null });
      // First registration: a GitHub repo (with the GitHub CLI ready) defaults to the PR flow
      // from the branch the folder is on.
      if (res.repo && !(await store.hasGitSettings(projectId))) {
        const r = res.repo;
        const base = r.currentBranch && r.remoteBranches.includes(r.currentBranch) ? r.currentBranch : r.defaultBranch;
        await store.updateProject(projectId, {
          git: { ...DEFAULT_GIT_SETTINGS, flow: r.github && r.ghReady ? 'pr' : 'local', baseBranch: base ?? null },
        });
      }
    } catch (err) {
      await store.updateProject(projectId, { status: 'error', error: (err as Error).message });
    }
    const project = (await store.getProject(projectId))!;
    hub.sendToUser(userId, { type: 'project.updated', project });
    return project;
  };

  api.post('/projects', async (c) => {
    const { name, deviceId, repoPath } = await body<{ name?: string; deviceId?: string; repoPath?: string }>(c);
    if (!name?.trim() || !deviceId || !repoPath?.trim()) throw new HttpError(400, 'Cần tên bảng, máy và đường dẫn repo.');
    await ownDevice(c, deviceId);
    const id = randomUUID();
    await store.createProject({ id, userId: c.get('userId'), deviceId, name: name.trim(), repoPath: repoPath.trim() });
    return c.json(await registerProject(c.get('userId'), id, deviceId, repoPath.trim()));
  });

  api.post('/projects/:id/retry', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    return c.json(await registerProject(c.get('userId'), p.id, p.deviceId, p.repoPath));
  });

  api.delete('/projects/:id', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const previewing = (await store.listCards(p.id)).filter((card) => card.preview).map((card) => card.id);
    for (const cardId of await store.deleteProject(p.id)) rmSync(attachmentDir(cardId), { recursive: true, force: true });
    // Best effort: stop the board's and its cards' dev servers and ngrok links on the bridge.
    void Promise.allSettled([
      ...(p.preview ? [hub.request(p.deviceId, 'project.preview.stop', { projectId: p.id }, 15_000)] : []),
      ...previewing.map((cardId) => hub.request(p.deviceId, 'card.preview.stop', { cardId }, 15_000)),
    ]);
    return c.json({ ok: true });
  });

  // Git settings of a board: how finished work reaches the repo.
  api.get('/projects/:id/repo', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    return c.json(await hub.request(p.deviceId, 'project.repo', { projectId: p.id, repoPath: p.repoPath }, 90_000));
  });

  api.put('/projects/:id/git', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const git = parseGitSettings(await body<Partial<GitSettings>>(c));
    await store.updateProject(p.id, { git });
    const project = (await store.getProject(p.id))!;
    hub.sendToUser(c.get('userId'), { type: 'project.updated', project });
    return c.json(project);
  });

  // Project memory and handoff notes live on the bridge machine (repo's .localkan/ folder);
  // the server only relays them.
  api.get('/projects/:id/memory', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    return c.json(await hub.request(p.deviceId, 'project.memory.get', { projectId: p.id, repoPath: p.repoPath }));
  });

  api.put('/projects/:id/memory', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const { content } = await body<{ content?: string }>(c);
    if (typeof content !== 'string') throw new HttpError(400, 'Thiếu nội dung.');
    if (content.length > 50_000) throw new HttpError(400, 'Bộ nhớ dự án tối đa 50.000 ký tự.');
    return c.json(await hub.request(p.deviceId, 'project.memory.set', { projectId: p.id, repoPath: p.repoPath, content }));
  });

  api.get('/projects/:id/handoffs', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    return c.json(await hub.request(p.deviceId, 'project.handoffs', { projectId: p.id, repoPath: p.repoPath }));
  });

  // Preview of the project folder itself (its checked-out branch, usually main).
  api.post('/projects/:id/preview', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const b = await body<{ tunnel?: boolean }>(c).catch(() => ({}) as { tunnel?: boolean });
    return c.json(
      await hub.request(p.deviceId, 'project.preview.start', { projectId: p.id, repoPath: p.repoPath, tunnel: b.tunnel !== false }, 900_000),
    );
  });

  api.delete('/projects/:id/preview', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    return c.json(await hub.request(p.deviceId, 'project.preview.stop', { projectId: p.id }));
  });

  // Remote control of the shared browser (Orca's built-in browser on the bridge machine).
  // `type` and `login` actions can carry passwords: relayed to the bridge only, never stored
  // or logged here.
  api.post('/projects/:id/browser', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const b = await body<{ action?: BrowserAction }>(c);
    const action = b.action;
    if (!action || typeof action !== 'object' || !BROWSER_KINDS.has(action.kind)) throw new HttpError(400, 'Lệnh trình duyệt không hợp lệ.');
    if (action.kind !== 'tabs' && action.kind !== 'open' && typeof action.pageId !== 'string') {
      throw new HttpError(400, 'Thiếu tab cần điều khiển.');
    }
    const result = await hub.request(p.deviceId, 'browser.action', { projectId: p.id, repoPath: p.repoPath, action }, 120_000);
    c.header('cache-control', 'no-store');
    return c.json(result);
  });

  api.post('/projects/:id/screenshots', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const b = await body<{ path?: string }>(c).catch(() => ({}) as { path?: string });
    return c.json(
      await hub.request(p.deviceId, 'project.screenshot', { projectId: p.id, repoPath: p.repoPath, path: b.path?.trim() || '/' }, 900_000),
    );
  });

  // Cards ---------------------------------------------------------------------

  api.get('/projects/:id/cards', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    return c.json(await store.listCards(p.id));
  });

  /** A parent must be another started card of the same board. */
  const checkParent = async (projectId: string, parentId: string, selfId: string | null): Promise<string> => {
    if (parentId === selfId) throw new HttpError(400, 'Thẻ không thể làm tiếp từ chính nó.');
    const r = await store.cardBrief(parentId);
    if (!r || r.projectId !== projectId) throw new HttpError(400, 'Thẻ nền không thuộc bảng này.');
    if (!r.branch) throw new HttpError(400, 'Thẻ nền chưa từng chạy nên chưa có gì để làm tiếp.');
    return parentId;
  };

  const parentRef = async (card: Card) => {
    if (!card.parentCardId) return null;
    const r = await store.cardBrief(card.parentCardId);
    return r ? { cardId: r._id, title: r.title, branch: r.branch ?? null } : null;
  };

  const parseAgent = (agent: unknown): AgentId => {
    if (!AGENTS.includes(agent as AgentId)) throw new HttpError(400, 'Agent không hợp lệ.');
    return agent as AgentId;
  };
  const parseMode = (mode: unknown): CardMode => (mode === 'ask' ? 'ask' : 'act');

  api.get('/cards/:id', async (c) => c.json((await ownCard(c, c.req.param('id'))).card));

  // -- push notifications (this browser/device) --------------------------------
  // The subscription endpoint is a capability URL: it travels in request bodies, never in URLs.

  api.get('/push/config', async (c) =>
    c.json({ publicKey: opts.push.publicKey, devices: await opts.push.count(c.get('userId')) }),
  );

  api.post('/push/subscription', async (c) => {
    const b = await body<{ subscription?: PushSubscriptionJSON; prefs?: Partial<NotifyPrefs>; label?: string }>(c);
    if (!b.subscription) throw new HttpError(400, 'Thiếu thông tin đăng ký thông báo.');
    const prefs = await opts.push.subscribe(c.get('userId'), b.subscription, b.prefs, String(b.label ?? 'Trình duyệt'));
    return c.json({ prefs });
  });

  api.post('/push/subscription/lookup', async (c) => {
    const b = await body<{ endpoint?: string }>(c);
    return c.json({ prefs: b.endpoint ? await opts.push.prefsOf(c.get('userId'), b.endpoint) : null });
  });

  api.post('/push/subscription/delete', async (c) => {
    const b = await body<{ endpoint?: string }>(c);
    if (b.endpoint) await opts.push.unsubscribe(c.get('userId'), b.endpoint);
    return c.json({ ok: true });
  });

  api.post('/push/test', async (c) => {
    const b = await body<{ endpoint?: string }>(c);
    if (!b.endpoint) throw new HttpError(400, 'Thiếu thiết bị cần thử.');
    await opts.push.test(c.get('userId'), b.endpoint);
    return c.json({ ok: true });
  });

  api.post('/projects/:id/cards', async (c) => {
    const p = await ownProject(c, c.req.param('id'));
    const b = await body<{
      title?: string;
      prompt?: string;
      agent?: string;
      mode?: string;
      parentCardId?: string | null;
      autoPreview?: boolean;
    }>(c);
    if (!b.title?.trim()) throw new HttpError(400, 'Thẻ cần có tiêu đề.');
    const parentCardId = b.parentCardId ? await checkParent(p.id, b.parentCardId, null) : null;
    const id = randomUUID();
    await store.createCard({
      id,
      projectId: p.id,
      title: b.title.trim(),
      prompt: (b.prompt ?? '').trim(),
      agent: parseAgent(b.agent ?? 'claude'),
      mode: parseMode(b.mode),
      position: (await store.maxTodoPosition(p.id)) + 1,
      parentCardId,
      autoPreview: b.autoPreview === true,
    });
    return c.json(pushCard(c.get('userId'), await store.getCard(id)));
  });

  api.patch('/cards/:id', async (c) => {
    const { card } = await ownCard(c, c.req.param('id'));
    const b = await body<Partial<Pick<Card, 'title' | 'prompt' | 'agent' | 'mode' | 'position' | 'parentCardId' | 'autoPreview'>>>(c);
    const patch: CardPatch = {};
    if (b.position !== undefined) patch.position = Number(b.position);
    if (b.autoPreview !== undefined) patch.autoPreview = b.autoPreview === true;
    // Task content is editable only before an agent picks it up.
    if (card.status === 'todo') {
      if (b.title !== undefined) patch.title = String(b.title).trim() || card.title;
      if (b.prompt !== undefined) patch.prompt = String(b.prompt);
      if (b.agent !== undefined) patch.agent = parseAgent(b.agent);
      if (b.mode !== undefined) patch.mode = parseMode(b.mode);
      if (b.parentCardId !== undefined)
        patch.parentCardId = b.parentCardId ? await checkParent(card.projectId, b.parentCardId, card.id) : null;
    }
    return c.json(pushCard(c.get('userId'), await store.updateCard(card.id, patch)));
  });

  api.delete('/cards/:id', async (c) => {
    const { card } = await ownCard(c, c.req.param('id'));
    if (card.status === 'in_progress' || card.status === 'needs_input')
      throw new HttpError(409, 'Thẻ đang chạy. Hãy dừng agent trước khi xóa.');
    await store.deleteCard(card.id);
    rmSync(attachmentDir(card.id), { recursive: true, force: true });
    hub.sendToUser(c.get('userId'), { type: 'card.deleted', cardId: card.id, projectId: card.projectId });
    return c.json({ ok: true });
  });

  // Images ------------------------------------------------------------------

  api.post('/cards/:id/attachments', async (c) => {
    const { card, userId } = await ownCard(c, c.req.param('id'));
    if (card.status !== 'todo') throw new HttpError(409, 'Chỉ thêm ảnh được khi thẻ còn ở To Do.');
    const form = await c.req.formData().catch(() => {
      throw new HttpError(400, 'Dữ liệu ảnh không hợp lệ.');
    });
    const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f);
    if (!files.length) throw new HttpError(400, 'Chưa có ảnh nào.');
    if (card.attachments.length + files.length > ATTACHMENT_LIMITS.maxFiles)
      throw new HttpError(400, `Mỗi thẻ tối đa ${ATTACHMENT_LIMITS.maxFiles} ảnh.`);
    for (const f of files) {
      if (!(ATTACHMENT_LIMITS.mimeTypes as readonly string[]).includes(f.type))
        throw new HttpError(400, `"${f.name}" không phải ảnh PNG, JPEG, WebP hoặc GIF.`);
      if (f.size > ATTACHMENT_LIMITS.maxBytes)
        throw new HttpError(400, `"${f.name}" lớn hơn ${ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB.`);
    }
    mkdirSync(attachmentDir(card.id), { recursive: true });
    const items = [];
    for (const [i, f] of files.entries()) {
      const id = randomUUID();
      writeFileSync(attachmentFile(card.id, id), Buffer.from(await f.arrayBuffer()));
      const name = (f.name || `anh-${card.attachments.length + i + 1}`).replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120);
      items.push({ id, name, mime: f.type, size: f.size });
    }
    return c.json(pushCard(userId, await store.addAttachments(card.id, items)));
  });

  api.get('/attachments/:id', async (c) => {
    const found = await store.findAttachment(c.req.param('id'));
    if (!found || found.userId !== c.get('userId')) throw new HttpError(404, 'Không tìm thấy ảnh.');
    return sendFile(found.cardId, found.attachment);
  });

  api.delete('/attachments/:id', async (c) => {
    const found = await store.findAttachment(c.req.param('id'));
    if (!found || found.userId !== c.get('userId')) throw new HttpError(404, 'Không tìm thấy ảnh.');
    const { card, userId } = await ownCard(c, found.cardId);
    if (card.status !== 'todo') throw new HttpError(409, 'Chỉ xóa ảnh được khi thẻ còn ở To Do.');
    const updated = await store.removeAttachment(card.id, found.attachment.id);
    rmSync(attachmentFile(card.id, found.attachment.id), { force: true });
    return c.json(pushCard(userId, updated));
  });

  api.post('/cards/:id/start', async (c) => {
    const { card, deviceId, repoPath, userId } = await ownCard(c, c.req.param('id'));
    if (card.status !== 'todo') throw new HttpError(409, 'Chỉ khởi chạy được thẻ ở cột To Do.');
    const project = await ownProject(c, card.projectId);
    if (project.status !== 'ready') throw new HttpError(409, 'Bảng chưa sẵn sàng (repo chưa được đăng ký với Orca).');
    pushCard(userId, await store.updateCard(card.id, { status: 'in_progress', runState: 'starting', error: null, summary: null, pr: null }));
    try {
      await hub.request(deviceId, 'card.start', {
        cardId: card.id,
        projectId: card.projectId,
        repoPath,
        title: card.title,
        prompt: card.prompt,
        agent: card.agent,
        mode: card.mode,
        attachments: card.attachments.map(({ id, name, mime }) => ({ id, name, mime })),
        parent: await parentRef(card),
        git: project.git,
      });
    } catch (err) {
      pushCard(userId, await store.updateCard(card.id, { status: 'todo', runState: 'failed', error: (err as Error).message }));
      throw err;
    }
    return c.json(await store.getCard(card.id));
  });

  // Run the task again from the start in the same worktree: after a failed start, or once a
  // one-time setup step on the bridge machine has been done.
  api.post('/cards/:id/retry', async (c) => {
    const { card, deviceId, repoPath, userId } = await ownCard(c, c.req.param('id'));
    const busy = card.runState === 'running' || card.runState === 'starting';
    if (card.status === 'todo' || card.status === 'done' || (busy && card.waiting?.kind !== 'setup'))
      throw new HttpError(409, 'Thẻ này không ở trạng thái chạy lại được.');
    const before = { status: card.status, runState: card.runState, waiting: card.waiting };
    const project = await ownProject(c, card.projectId);
    pushCard(userId, await store.updateCard(card.id, { status: 'in_progress', runState: 'starting', waiting: null, error: null, summary: null }));
    try {
      await hub.request(deviceId, 'card.retry', {
        cardId: card.id,
        projectId: card.projectId,
        repoPath,
        title: card.title,
        prompt: card.prompt,
        agent: card.agent,
        mode: card.mode,
        attachments: card.attachments.map(({ id, name, mime }) => ({ id, name, mime })),
        parent: await parentRef(card),
        git: project.git,
      });
    } catch (err) {
      pushCard(userId, await store.updateCard(card.id, { ...before, error: (err as Error).message }));
      throw err;
    }
    return c.json(await store.getCard(card.id));
  });

  api.post('/cards/:id/reply', async (c) => {
    const { card, deviceId, userId } = await ownCard(c, c.req.param('id'));
    const b = await body<{ messageId?: string; text?: string; keys?: TerminalKey[] }>(c);
    await hub.request(deviceId, 'card.reply', { cardId: card.id, messageId: b.messageId, text: b.text, keys: b.keys });
    return c.json(pushCard(userId, await store.updateCard(card.id, {})));
  });

  api.post('/cards/:id/followup', async (c) => {
    const { card, deviceId, userId } = await ownCard(c, c.req.param('id'));
    const b = await body<{ text?: string; comments?: ReviewComment[] }>(c);
    const text = composeFollowup(b.text ?? '', b.comments ?? []);
    if (!text) throw new HttpError(400, 'Hãy viết nhận xét hoặc yêu cầu sửa.');
    pushCard(userId, await store.updateCard(card.id, { status: 'in_progress', runState: 'starting', error: null }));
    try {
      await hub.request(deviceId, 'card.followup', { cardId: card.id, text });
    } catch (err) {
      pushCard(userId, await store.updateCard(card.id, { status: card.status, runState: card.runState, error: (err as Error).message }));
      throw err;
    }
    return c.json(await store.getCard(card.id));
  });

  api.get('/cards/:id/diff', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    return c.json(await hub.request(deviceId, 'card.diff', { cardId: card.id }, 60_000));
  });

  api.get('/cards/:id/screen', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    return c.json(await hub.request(deviceId, 'card.screen', { cardId: card.id }));
  });

  api.get('/cards/:id/log', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    const after = c.req.query('after');
    return c.json(await hub.request(deviceId, 'card.log', { cardId: card.id, after: after ? Number(after) : undefined }));
  });

  api.post('/cards/:id/stop', async (c) => {
    const { card, deviceId, userId } = await ownCard(c, c.req.param('id'));
    await hub.request(deviceId, 'card.stop', { cardId: card.id });
    return c.json(pushCard(userId, await store.updateCard(card.id, {})));
  });

  // Live preview of the card's worktree (dev server + optional ngrok link) and screenshots.
  // Starting can take minutes the first time (dependency install).
  api.post('/cards/:id/preview', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    if (!card.worktreePath || card.status === 'todo' || card.status === 'done')
      throw new HttpError(409, 'Chỉ xem trước được thẻ đang có worktree (đã giao việc, chưa hoàn tất).');
    const b = await body<{ tunnel?: boolean }>(c).catch(() => ({}) as { tunnel?: boolean });
    return c.json(await hub.request(deviceId, 'card.preview.start', { cardId: card.id, tunnel: b.tunnel !== false }, 900_000));
  });

  api.delete('/cards/:id/preview', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    return c.json(await hub.request(deviceId, 'card.preview.stop', { cardId: card.id }));
  });

  api.post('/cards/:id/screenshots', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    if (!card.worktreePath || card.status === 'todo' || card.status === 'done')
      throw new HttpError(409, 'Chỉ chụp được thẻ đang có worktree (đã giao việc, chưa hoàn tất).');
    const b = await body<{ path?: string }>(c).catch(() => ({}) as { path?: string });
    return c.json(await hub.request(deviceId, 'card.screenshot', { cardId: card.id, path: b.path?.trim() || '/' }, 900_000));
  });

  api.post('/cards/:id/focus', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    await hub.request(deviceId, 'card.focus', { cardId: card.id });
    return c.json({ ok: true });
  });

  api.post('/cards/:id/finish', async (c) => {
    const { card, deviceId, userId } = await ownCard(c, c.req.param('id'));
    if (card.status === 'done') throw new HttpError(409, 'Thẻ này đã được hoàn tất rồi.');
    const b = await body<{ action?: FinishAction; commitMessage?: string }>(c);
    const action = b.action ?? 'commit';
    if (!['merge_pr', 'commit', 'pr', 'merge', 'discard'].includes(action)) throw new HttpError(400, 'Hành động không hợp lệ.');
    const project = await ownProject(c, card.projectId);
    const res = await hub.request(
      deviceId,
      'card.finish',
      { cardId: card.id, action, commitMessage: b.commitMessage?.trim() || card.title, git: project.git },
      300_000,
    );
    const updated = await store.updateCard(card.id, {
      status: 'done',
      runState: 'idle',
      waiting: null,
      prUrl: res.prUrl ?? card.prUrl,
      summary: res.message,
      error: null,
      preview: null,
      pr: null,
    });
    return c.json(pushCard(userId, updated));
  });

  // -- GitHub pull requests of a task --------------------------------------------

  api.post('/cards/:id/pr/refresh', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    return c.json(await hub.request(deviceId, 'card.pr.refresh', { cardId: card.id }, 60_000));
  });

  api.post('/cards/:id/pr/sync', async (c) => {
    const { card, deviceId } = await ownCard(c, c.req.param('id'));
    return c.json(await hub.request(deviceId, 'card.pr.sync', { cardId: card.id }, 180_000));
  });

  return api;
}

function composeFollowup(text: string, comments: ReviewComment[]): string {
  const parts: string[] = [];
  if (comments.length) {
    parts.push('Reviewer comments on your changes. Address each one:');
    for (const cm of comments) {
      const where = cm.line ? `${cm.path}:${cm.line}` : cm.path;
      parts.push(`- ${where}: ${cm.text}`);
      if (cm.snippet) parts.push('  ```\n' + cm.snippet.split('\n').map((l) => `  ${l}`).join('\n') + '\n  ```');
    }
  }
  if (text.trim()) parts.push(text.trim());
  return parts.join('\n');
}

const REF = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]+$/;

/** Validate git settings from the browser; branch names must be safe to pass to git. */
function parseGitSettings(b: Partial<GitSettings>): GitSettings {
  const flow = b.flow === 'pr' ? 'pr' : 'local';
  const baseBranch = typeof b.baseBranch === 'string' && b.baseBranch.trim() ? b.baseBranch.trim() : null;
  if (baseBranch && (baseBranch.length > 100 || !REF.test(baseBranch) || baseBranch.endsWith('/') || baseBranch.endsWith('.lock'))) {
    throw new HttpError(400, 'Tên nhánh gốc không hợp lệ.');
  }
  const branchPrefix = typeof b.branchPrefix === 'string' ? b.branchPrefix.trim() : DEFAULT_GIT_SETTINGS.branchPrefix;
  if (branchPrefix && (branchPrefix.length > 40 || !REF.test(branchPrefix))) throw new HttpError(400, 'Tiền tố nhánh không hợp lệ.');
  const mergeMethod = b.mergeMethod === 'merge' || b.mergeMethod === 'rebase' ? b.mergeMethod : 'squash';
  return { flow, baseBranch, branchPrefix, mergeMethod, autoDraftPr: b.autoDraftPr !== false };
}
