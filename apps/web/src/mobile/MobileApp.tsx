import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Card, Device, LogLine, Project } from '@localkan/protocol';
import { CardPanel } from '../components/CardPanel.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { RemoteBrowser } from '../components/RemoteBrowser.tsx';
import { GitSettingsDialog } from '../components/GitSettingsDialog.tsx';
import { ProjectPreview } from '../components/PreviewTab.tsx';
import type { ToastApi } from '../components/Toasts.tsx';
import { CardScreen } from './CardScreen.tsx';
import { NewTask } from './NewTask.tsx';
import { Overview } from './Overview.tsx';

/** Phone layout: an overview of every board's work, a quick "new task" screen, and one screen
 *  per card. Screens live in the URL hash so the phone's back gesture works. */
export function MobileApp({
  email,
  projects,
  devices,
  cards,
  logs,
  setCardLog,
  live,
  lastProjectId,
  toasts,
  onLogout,
  onBoardView,
  pushOn,
  onNotify,
}: {
  email: string;
  projects: Project[];
  devices: Device[];
  cards: Record<string, Card>;
  logs: Record<string, LogLine[]>;
  setCardLog: (cardId: string, lines: LogLine[]) => void;
  live: boolean;
  lastProjectId: string | null;
  toasts: ToastApi;
  onLogout: () => void;
  onBoardView: () => void;
  /** Whether this device receives push notifications (null while checking). */
  pushOn: boolean | null;
  onNotify: () => void;
}) {
  const [hash, setHash] = useState(() => location.hash);
  const inApp = useRef(false);
  const [menu, setMenu] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [tool, setTool] = useState<{ kind: 'browser' | 'preview' | 'git'; projectId: string } | null>(null);

  // Each screen starts at the top (the overview's scroll position must not carry over).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [hash]);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((h: string) => {
    inApp.current = true;
    location.hash = h;
  }, []);
  // Back within the app uses history (so the phone's back gesture and this button agree);
  // a deep link opened directly falls back to the overview.
  const back = useCallback(() => {
    if (inApp.current) history.back();
    else {
      history.replaceState(null, '', location.pathname + location.search);
      setHash('');
    }
  }, []);

  const all = useMemo(() => Object.values(cards), [cards]);
  const route = parse(hash);
  const card = route.name === 'card' ? (cards[route.id] ?? null) : null;
  const cardProject = card ? projects.find((p) => p.id === card.projectId) : undefined;
  const fullCard = full ? cards[full] : null;
  const fullProject = fullCard ? projects.find((p) => p.id === fullCard.projectId) : undefined;
  const toolProject = tool ? projects.find((p) => p.id === tool.projectId) : undefined;

  return (
    <div className="m-app">
      {route.name === 'new' ? (
        <NewTask
          projects={projects}
          cards={all}
          initialProjectId={lastProjectId}
          toasts={toasts}
          onClose={back}
          onCreated={(c) => {
            history.replaceState(null, '', `${location.pathname}${location.search}#card/${c.id}`);
            setHash(`#card/${c.id}`);
          }}
        />
      ) : route.name === 'card' && card && cardProject ? (
        <CardScreen
          key={card.id}
          card={card}
          project={cardProject}
          cards={all.filter((c) => c.projectId === card.projectId)}
          log={logs[card.id] ?? []}
          setLog={setCardLog}
          toasts={toasts}
          startPreview={route.preview}
          onBack={back}
          onFull={() => setFull(card.id)}
        />
      ) : route.name === 'card' ? (
        <div className="m-screen">
          <header className="m-bar">
            <button className="m-icon-btn" onClick={back} aria-label="Quay lại">
              ←
            </button>
            <h1>Việc</h1>
            <span className="m-icon-btn ghost" aria-hidden />
          </header>
          <div className="m-empty">
            <p>Không thấy việc này. Có thể nó đã bị xóa hoặc đang tải.</p>
          </div>
        </div>
      ) : (
        <Overview
          projects={projects}
          devices={devices}
          cards={all}
          live={live}
          toasts={toasts}
          go={go}
          onMenu={() => setMenu(true)}
          pushOn={pushOn}
          onNotify={onNotify}
        />
      )}

      {menu && (
        <div className="m-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setMenu(false)}>
          <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="m-sheet-head">
              <strong>Localkan</strong>
              <button className="m-icon-btn" onClick={() => setMenu(false)} aria-label="Đóng">
                ✕
              </button>
            </div>
            <p className="muted small">
              {email} · {live ? 'đang nhận cập nhật trực tiếp' : 'mất kết nối, đang thử lại'}
            </p>
            {devices.map((d) => (
              <p key={d.id} className="small">
                <span className={`dot ${d.online ? 'ok' : 'off'}`} /> {d.name} {d.online ? '(online)' : '(offline)'}
              </p>
            ))}
            {projects.map((p) => (
              <div key={p.id} className="m-menu-board">
                <strong>{p.name}</strong>
                <div className="m-row">
                  <button className="m-btn small" onClick={() => (setMenu(false), setTool({ kind: 'browser', projectId: p.id }))}>
                    🌐 Trình duyệt
                  </button>
                  <button className="m-btn small" onClick={() => (setMenu(false), setTool({ kind: 'preview', projectId: p.id }))}>
                    👁 Xem trước {p.baseRef ?? 'main'}
                    {p.preview?.status === 'running' && ' ●'}
                  </button>
                  <button className="m-btn small" onClick={() => (setMenu(false), setTool({ kind: 'git', projectId: p.id }))}>
                    ⑂ {p.git.flow === 'pr' ? `PR → ${p.git.baseBranch ?? p.baseRef ?? 'main'}` : p.git.flow === 'push' ? `Push → ${p.git.baseBranch ?? p.baseRef ?? 'main'}` : 'Git'}
                  </button>
                </div>
              </div>
            ))}
            <button className="m-btn" onClick={() => (setMenu(false), onNotify())}>
              {pushOn ? '🔔 Thông báo (đang bật)' : '🔕 Bật thông báo'}
            </button>
            <button className="m-btn" onClick={onBoardView}>
              ▦ Chuyển sang dạng bảng Kanban
            </button>
            <button className="m-btn danger" onClick={onLogout}>
              Đăng xuất
            </button>
          </div>
        </div>
      )}

      {tool && toolProject && tool.kind === 'git' && (
        <GitSettingsDialog project={toolProject} onClose={() => setTool(null)} toasts={toasts} />
      )}
      {tool && toolProject && tool.kind !== 'git' && (
        <Dialog
          title={tool.kind === 'browser' ? `Trình duyệt · ${toolProject.name}` : `Xem trước ${toolProject.baseRef ?? 'main'} · ${toolProject.name}`}
          onClose={() => setTool(null)}
          wide
        >
          {tool.kind === 'browser' ? (
            <RemoteBrowser project={toolProject} cards={all.filter((c) => c.projectId === toolProject.id)} toasts={toasts} />
          ) : (
            <ProjectPreview project={toolProject} toasts={toasts} />
          )}
        </Dialog>
      )}

      {fullCard && fullProject && (
        <CardPanel
          key={fullCard.id}
          card={fullCard}
          cards={all.filter((c) => c.projectId === fullCard.projectId)}
          project={fullProject}
          log={logs[fullCard.id] ?? []}
          setLog={setCardLog}
          onClose={() => setFull(null)}
          toasts={toasts}
        />
      )}
    </div>
  );
}

type Route = { name: 'overview' } | { name: 'new' } | { name: 'card'; id: string; preview: boolean };

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'new') return { name: 'new' };
  const m = h.match(/^card\/([\w-]+)(\/preview)?$/);
  if (m) return { name: 'card', id: m[1], preview: !!m[2] };
  return { name: 'overview' };
}
