import type {
  GitSettings,
  PrInfo,
  RepoInfo,
  NotifyPrefs,
  PushSubscriptionJSON,
  BrowserAction,
  BrowserResult,
  Card,
  Device,
  DiffResult,
  FolderInfo,
  HandoffNote,
  FinishAction,
  LogLine,
  PreviewInfo,
  Project,
  ReviewComment,
  Screenshot,
  ServerToWeb,
  TerminalKey,
} from '@localkan/protocol';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Lỗi ${res.status}`);
  return data as T;
}

export interface AuthState {
  needsSetup: boolean;
  user: { id: string; email: string } | null;
}

export const api = {
  authState: () => call<AuthState>('GET', '/auth/state'),
  setup: (email: string, password: string) => call('POST', '/auth/setup', { email, password }),
  login: (email: string, password: string) => call('POST', '/auth/login', { email, password }),
  logout: () => call('POST', '/auth/logout'),

  devices: () => call<Device[]>('GET', '/devices'),
  pairingCode: () => call<{ code: string; expiresAt: string }>('POST', '/devices/pairing-code'),
  removeDevice: (id: string) => call('DELETE', `/devices/${id}`),

  projects: () => call<Project[]>('GET', '/projects'),
  createProject: (p: { name: string; deviceId: string; repoPath: string }) => call<Project>('POST', '/projects', p),
  retryProject: (id: string) => call<Project>('POST', `/projects/${id}/retry`),
  deleteProject: (id: string) => call('DELETE', `/projects/${id}`),

  cards: (projectId: string) => call<Card[]>('GET', `/projects/${projectId}/cards`),
  createCard: (projectId: string, c: Pick<Card, 'title' | 'prompt' | 'agent' | 'mode' | 'parentCardId'> & { autoPreview?: boolean }) =>
    call<Card>('POST', `/projects/${projectId}/cards`, c),
  updateCard: (id: string, patch: Partial<Pick<Card, 'title' | 'prompt' | 'agent' | 'mode' | 'position' | 'parentCardId' | 'autoPreview'>>) =>
    call<Card>('PATCH', `/cards/${id}`, patch),
  previewStart: (id: string, tunnel: boolean) => call<PreviewInfo>('POST', `/cards/${id}/preview`, { tunnel }),
  previewStop: (id: string) => call('DELETE', `/cards/${id}/preview`),
  screenshots: (id: string, path: string) => call<{ shots: Screenshot[] }>('POST', `/cards/${id}/screenshots`, { path }),
  card: (id: string) => call<Card>('GET', `/cards/${id}`),
  projectRepo: (id: string) => call<RepoInfo>('GET', `/projects/${id}/repo`),
  saveGit: (id: string, git: GitSettings) => call<Project>('PUT', `/projects/${id}/git`, git),
  prRefresh: (cardId: string) => call<{ pr: PrInfo | null }>('POST', `/cards/${cardId}/pr/refresh`),
  prSync: (cardId: string) => call<{ ok: boolean; conflict: boolean; message: string }>('POST', `/cards/${cardId}/pr/sync`),
  pushConfig: () => call<{ publicKey: string; devices: number }>('GET', '/push/config'),
  pushSubscribe: (subscription: PushSubscriptionJSON, prefs: Partial<NotifyPrefs> | undefined, label: string) =>
    call<{ prefs: NotifyPrefs }>('POST', '/push/subscription', { subscription, prefs, label }),
  pushLookup: (endpoint: string) => call<{ prefs: NotifyPrefs | null }>('POST', '/push/subscription/lookup', { endpoint }),
  pushDelete: (endpoint: string) => call('POST', '/push/subscription/delete', { endpoint }),
  pushTest: (endpoint: string) => call('POST', '/push/test', { endpoint }),
  browser: (projectId: string, action: BrowserAction) => call<BrowserResult>('POST', `/projects/${projectId}/browser`, { action }),
  projectPreviewStart: (id: string, tunnel: boolean) => call<PreviewInfo>('POST', `/projects/${id}/preview`, { tunnel }),
  projectPreviewStop: (id: string) => call('DELETE', `/projects/${id}/preview`),
  projectScreenshots: (id: string, path: string) =>
    call<{ shots: Screenshot[] }>('POST', `/projects/${id}/screenshots`, { path }),
  memory: (projectId: string) => call<{ content: string; path: string }>('GET', `/projects/${projectId}/memory`),
  saveMemory: (projectId: string, content: string) => call('PUT', `/projects/${projectId}/memory`, { content }),
  handoffs: (projectId: string) => call<{ handoffs: HandoffNote[] }>('GET', `/projects/${projectId}/handoffs`),
  deleteCard: (id: string) => call('DELETE', `/cards/${id}`),
  start: (id: string) => call<Card>('POST', `/cards/${id}/start`),
  retry: (id: string) => call<Card>('POST', `/cards/${id}/retry`),
  reply: (id: string, r: { messageId?: string; text?: string; keys?: TerminalKey[] }) =>
    call<Card>('POST', `/cards/${id}/reply`, r),
  followup: (id: string, text: string, comments: ReviewComment[]) =>
    call<Card>('POST', `/cards/${id}/followup`, { text, comments }),
  diff: (id: string) => call<DiffResult>('GET', `/cards/${id}/diff`),
  screen: (id: string) => call<{ lines: string[] }>('GET', `/cards/${id}/screen`),
  log: (id: string, after?: number) =>
    call<{ lines: LogLine[] }>('GET', `/cards/${id}/log${after !== undefined ? `?after=${after}` : ''}`),
  stop: (id: string) => call<Card>('POST', `/cards/${id}/stop`),
  focus: (id: string) => call('POST', `/cards/${id}/focus`),
  finish: (id: string, action: FinishAction, commitMessage: string) =>
    call<Card>('POST', `/cards/${id}/finish`, { action, commitMessage }),

  uploadAttachments: async (cardId: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const res = await fetch(`/api/cards/${cardId}/attachments`, { method: 'POST', body: form, credentials: 'same-origin' });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Lỗi ${res.status}`);
    return data as Card;
  },
  deleteAttachment: (id: string) => call<Card>('DELETE', `/attachments/${id}`),
  attachmentUrl: (id: string) => `/api/attachments/${id}`,

  pickFolder: (deviceId: string, startPath?: string) =>
    call<{ path: string | null; info: FolderInfo | null }>('POST', `/devices/${deviceId}/pick-folder`, { startPath }),
  inspectFolder: (deviceId: string, path: string) => call<FolderInfo>('POST', `/devices/${deviceId}/inspect-folder`, { path }),
};

/** Live updates from the server. Reconnects with backoff; calls onOpen after each (re)connect
 *  so the caller can refetch anything it may have missed while disconnected. */
export function connectLive(onMessage: (msg: ServerToWeb) => void, onOpen: () => void, onStatus: (up: boolean) => void) {
  let socket: WebSocket | null = null;
  let closed = false;
  let delay = 500;

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/api/ws`);
    socket.onopen = () => {
      delay = 500;
      onStatus(true);
      onOpen();
    };
    socket.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(String(ev.data)) as ServerToWeb);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      onStatus(false);
      if (closed) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  open();
  return () => {
    closed = true;
    socket?.close();
  };
}
