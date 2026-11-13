import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Card, Device, LogLine, Project, ServerToWeb } from '@localkan/protocol';
import { api, type AuthState, connectLive } from './api.ts';
import { AuthScreen } from './components/AuthScreen.tsx';
import { Board } from './components/Board.tsx';
import { CardPanel } from './components/CardPanel.tsx';
import { DevicesDialog } from './components/DevicesDialog.tsx';
import { Dialog } from './components/Dialog.tsx';
import { MemoryDialog } from './components/MemoryDialog.tsx';
import { ProjectPreview } from './components/PreviewTab.tsx';
import { RemoteBrowser } from './components/RemoteBrowser.tsx';
import { ProjectDialog } from './components/ProjectDialog.tsx';
import { Toasts, useToasts } from './components/Toasts.tsx';
import { MobileApp } from './mobile/MobileApp.tsx';
import { NotificationsDialog } from './components/NotificationsDialog.tsx';
import { GitSettingsDialog } from './components/GitSettingsDialog.tsx';
import { currentSubscription, pushSupport, syncPush } from './push.ts';

const LAST_PROJECT_KEY = 'localkan.lastProject';
const VIEW_KEY = 'localkan.view';
const NARROW = '(max-width: 760px)';

/** True on phone-sized screens. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    const m = matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

function readViewPref(): 'auto' | 'board' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'auto';
  } catch {
    return 'auto';
  }
}
const MAX_LOG_LINES = 5000;

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);

  const refreshAuth = useCallback(() => {
    api.authState().then(setAuth, () => setAuth({ needsSetup: false, user: null }));
  }, []);
  useEffect(refreshAuth, [refreshAuth]);

  if (!auth) return <div className="splash">Đang tải…</div>;
  if (!auth.user) return <AuthScreen needsSetup={auth.needsSetup} onDone={refreshAuth} />;
  return <Workspace email={auth.user.email} onLogout={() => api.logout().finally(refreshAuth)} />;
}

function Workspace({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [projectId, setProjectId] = useState<string | null>(readLastProject);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'devices' | 'project' | 'memory' | 'preview' | 'browser' | 'notify' | 'git' | null>(null);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [live, setLive] = useState(false);
  const toasts = useToasts();
  const narrow = useNarrow();
  const [viewPref, setViewPrefState] = useState(readViewPref);
  const setViewPref = (v: 'auto' | 'board') => {
    setViewPrefState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  const mobile = narrow && viewPref !== 'board';
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;

  const project = projects.find((p) => p.id === projectId) ?? null;

  const loadAll = useCallback(async () => {
    const [ps, ds] = await Promise.all([api.projects(), api.devices()]);
    setProjects(ps);
    setDevices(ds);
    if (!ps.length) setDialog((d) => d ?? (ds.length ? 'project' : 'devices'));
  }, []);

  const loadCards = useCallback(async (pid: string) => {
    const list = await api.cards(pid);
    setCards((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([, c]) => c.projectId !== pid));
      for (const c of list) next[c.id] = c;
      return next;
    });
  }, []);

  // Pick a project once the list is known.
  useEffect(() => {
    if (!projects.length) return;
    if (!projectId || !projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Only once the board is known: the remembered board may have been deleted since.
  const projectKnown = projects.some((p) => p.id === projectId);
  useEffect(() => {
    if (!projectId || !projectKnown) return;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      /* storage unavailable */
    }
    loadCards(projectId).catch((e) => toasts.error(e.message));
  }, [projectId, projectKnown, loadCards, toasts]);

  // Notifications: keep this device's subscription known to the server, and show whether
  // this device gets notifications at all.
  useEffect(() => {
    syncPush();
    if (pushSupport().ok) currentSubscription().then((s) => setPushOn(!!s && Notification.permission === 'granted'), () => setPushOn(false));
    else setPushOn(false);
  }, [dialog]);

  // A tapped notification asks the open window to show that task.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'localkan.open' && typeof e.data.hash === 'string') location.hash = e.data.hash;
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  // Board layout: `#card/<id>` (from a notification or a shared link) opens that card.
  useEffect(() => {
    if (mobile) return;
    const open = () => {
      const m = location.hash.match(/^#\/?card\/([\w-]+)/);
      if (!m) return;
      history.replaceState(null, '', location.pathname + location.search);
      api.card(m[1]).then(
        (c) => {
          setCards((prev) => ({ ...prev, [c.id]: c }));
          setProjectId(c.projectId);
          setOpenCardId(c.id);
        },
        (e) => toasts.error(e.message),
      );
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, [mobile, toasts]);

  // The phone overview shows every board's work, so it needs all boards' cards.
  const projectIds = projects.map((p) => p.id).join(',');
  const loadAllCards = useCallback(
    () => Promise.all(projectIds.split(',').filter(Boolean).map((id) => loadCards(id).catch(() => {}))),
    [projectIds, loadCards],
  );
  const loadAllCardsRef = useRef(loadAllCards);
  loadAllCardsRef.current = loadAllCards;
  useEffect(() => {
    if (mobile) loadAllCards();
  }, [mobile, loadAllCards]);

  useEffect(() => {
    const onMessage = (msg: ServerToWeb) => {
      switch (msg.type) {
        case 'card.updated':
          setCards((prev) => ({ ...prev, [msg.card.id]: msg.card }));
          break;
        case 'card.deleted':
          setCards((prev) => {
            const next = { ...prev };
            delete next[msg.cardId];
            return next;
          });
          break;
        case 'card.log':
          setLogs((prev) => {
            const existing = prev[msg.cardId] ?? [];
            const last = existing.at(-1)?.seq ?? -1;
            const fresh = msg.lines.filter((l) => l.seq > last);
            if (!fresh.length) return prev;
            return { ...prev, [msg.cardId]: [...existing, ...fresh].slice(-MAX_LOG_LINES) };
          });
          break;
        case 'device.updated':
          setDevices((prev) => {
            const i = prev.findIndex((d) => d.id === msg.device.id);
            if (i < 0) return [...prev, msg.device];
            const next = [...prev];
            next[i] = msg.device;
            return next;
          });
          break;
        case 'project.updated':
          setProjects((prev) => {
            const i = prev.findIndex((p) => p.id === msg.project.id);
            if (i < 0) return [...prev, msg.project];
            const next = [...prev];
            next[i] = msg.project;
            return next;
          });
          break;
      }
    };
    return connectLive(
      onMessage,
      () => {
        loadAll().catch(() => {});
        if (mobileRef.current) loadAllCardsRef.current();
        else if (projectId) loadCards(projectId).catch(() => {});
      },
      setLive,
    );
    // Reconnect logic only needs the latest loaders; projectId changes are handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAll, loadCards]);

  const projectCards = useMemo(
    () => Object.values(cards).filter((c) => c.projectId === projectId),
    [cards, projectId],
  );
  const openCard = openCardId ? cards[openCardId] ?? null : null;
  const device = project ? devices.find((d) => d.id === project.deviceId) ?? null : null;

  const setCardLog = useCallback((cardId: string, lines: LogLine[]) => {
    setLogs((prev) => ({ ...prev, [cardId]: lines.slice(-MAX_LOG_LINES) }));
  }, []);

  if (mobile) {
    return (
      <>
        <MobileApp
          email={email}
          projects={projects}
          devices={devices}
          cards={cards}
          logs={logs}
          setCardLog={setCardLog}
          live={live}
          lastProjectId={projectId}
          toasts={toasts}
          onLogout={onLogout}
          onBoardView={() => setViewPref('board')}
          pushOn={pushOn}
          onNotify={() => setDialog('notify')}
        />
        {dialog === 'notify' && <NotificationsDialog onClose={() => setDialog(null)} toasts={toasts} />}
        <Toasts state={toasts} />
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▦
          </span>
          Localkan
        </div>
        <select
          className="project-select"
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value || null)}
          aria-label="Chọn bảng"
        >
          {projects.length === 0 && <option value="">Chưa có bảng</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={() => setDialog('project')}>
          + Bảng mới
        </button>
        {project && (
          <button
            className="btn ghost"
            onClick={() => setDialog('memory')}
            title="Bộ nhớ dự án và ghi chú bàn giao giữa các thẻ"
            aria-label="Bộ nhớ"
          >
            🧠<span className="topbar-label"> Bộ nhớ</span>
          </button>
        )}
        {project && (
          <button
            className="btn ghost"
            onClick={() => setDialog('preview')}
            title="Chạy và xem trước thư mục dự án (nhánh đang checkout, thường là main)"
            aria-label={`Xem trước ${project.baseRef ?? 'main'}`}
          >
            👁<span className="topbar-label"> Xem trước {project.baseRef ?? 'main'}</span>
            {project.preview?.status === 'running' && <span className="dot ok" style={{ marginLeft: 6 }} />}
          </button>
        )}
        {project && (
          <button
            className="btn ghost"
            onClick={() => setDialog('browser')}
            title="Trình duyệt dùng chung với agent (trình duyệt của Orca trên máy chạy bridge): xem, bấm, gõ, đăng nhập từ xa"
            aria-label="Trình duyệt"
          >
            🌐<span className="topbar-label"> Trình duyệt</span>
          </button>
        )}
        {project && (
          <button
            className="btn ghost"
            onClick={() => setDialog('git')}
            title={
              project.git.flow === 'pr'
                ? `Git: Pull Request vào ${project.git.baseBranch ?? project.baseRef ?? 'main'}`
                : project.git.flow === 'push'
                  ? `Git: merge rồi push lên ${project.git.baseBranch ?? project.baseRef ?? 'main'}`
                  : 'Git: merge cục bộ'
            }
            aria-label="Cài đặt git"
          >
            ⑂<span className="topbar-label"> {project.git.flow === 'pr' ? 'PR' : project.git.flow === 'push' ? 'Push' : 'Git'}</span>
          </button>
        )}
        <div className="spacer" />
        <button
          className="btn ghost"
          onClick={() => setDialog('notify')}
          title={pushOn ? 'Thông báo đang bật trên thiết bị này' : 'Bật thông báo khi việc xong'}
          aria-label="Thông báo"
        >
          {pushOn ? '🔔' : '🔕'}
        </button>
        <button className="btn ghost device-pill" onClick={() => setDialog('devices')} title="Máy chạy bridge">
          <span className={`dot ${device?.online ? 'ok' : 'off'}`} />
          {device ? device.name : `${devices.length} máy`}
        </button>
        <span className={`live ${live ? 'ok' : 'off'}`} title={live ? 'Đang nhận cập nhật trực tiếp' : 'Mất kết nối'}>
          {live ? 'Live' : 'Offline'}
        </span>
        <span className="muted email">{email}</span>
        {narrow && (
          <button className="btn ghost" onClick={() => setViewPref('auto')} title="Giao diện gọn cho điện thoại">
            📱
          </button>
        )}
        <button className="btn ghost" onClick={onLogout}>
          Đăng xuất
        </button>
      </header>

      {project ? (
        <Board
          project={project}
          device={device}
          cards={projectCards}
          onOpen={setOpenCardId}
          onRetryProject={() => api.retryProject(project.id).catch((e) => toasts.error(e.message))}
          toasts={toasts}
        />
      ) : (
        <div className="empty-state">
          <h2>Bắt đầu</h2>
          <ol>
            <li>Ghép nối máy tính của bạn (nơi có repo, Orca và các agent CLI).</li>
            <li>Tạo một bảng gắn với một repo git trên máy đó.</li>
            <li>Thêm thẻ việc, kéo sang In Progress để agent bắt đầu.</li>
          </ol>
          <div className="row">
            <button className="btn" onClick={() => setDialog('devices')}>
              Ghép nối máy
            </button>
            <button className="btn primary" onClick={() => setDialog('project')} disabled={!devices.length}>
              Tạo bảng
            </button>
          </div>
        </div>
      )}

      {openCard && project && (
        <CardPanel
          key={openCard.id}
          card={openCard}
          cards={projectCards}
          project={project}
          log={logs[openCard.id] ?? []}
          setLog={setCardLog}
          onClose={() => setOpenCardId(null)}
          toasts={toasts}
        />
      )}

      {dialog === 'notify' && <NotificationsDialog onClose={() => setDialog(null)} toasts={toasts} />}
      {dialog === 'git' && project && <GitSettingsDialog project={project} onClose={() => setDialog(null)} toasts={toasts} />}
      {dialog === 'memory' && project && <MemoryDialog project={project} onClose={() => setDialog(null)} toasts={toasts} />}
      {dialog === 'browser' && project && (
        <Dialog title={`Trình duyệt dùng chung · ${project.name}`} onClose={() => setDialog(null)} wide>
          <RemoteBrowser project={project} cards={projectCards} toasts={toasts} />
        </Dialog>
      )}
      {dialog === 'preview' && project && (
        <Dialog title={`Xem trước ${project.baseRef ?? 'main'} · ${project.name}`} onClose={() => setDialog(null)} wide>
          <ProjectPreview project={project} toasts={toasts} />
        </Dialog>
      )}
      {dialog === 'devices' && (
        <DevicesDialog devices={devices} onClose={() => setDialog(null)} onChanged={loadAll} toasts={toasts} />
      )}
      {dialog === 'project' && (
        <ProjectDialog
          devices={devices}
          onClose={() => setDialog(null)}
          onCreated={(p) => {
            setProjects((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
            setProjectId(p.id);
            setDialog(null);
          }}
          onPair={() => setDialog('devices')}
          toasts={toasts}
        />
      )}
      <Toasts state={toasts} />
    </div>
  );
}
