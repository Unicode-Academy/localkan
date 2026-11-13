import { useMemo, useState } from 'react';
import { AGENT_LABELS, type Card, type Device, type Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { ciSummary } from '../components/PrPanel.tsx';
import type { ToastApi } from '../components/Toasts.tsx';
import { badge, bucket, byUrgency, splitOptions, timeAgo, type Bucket } from './status.ts';

type Filter = 'all' | 'you' | 'running' | 'failed';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'you', label: 'Cần bạn' },
  { id: 'running', label: 'Đang chạy' },
  { id: 'failed', label: 'Lỗi' },
];

export function Overview({
  projects,
  devices,
  cards,
  live,
  toasts,
  go,
  onMenu,
  pushOn,
  onNotify,
}: {
  projects: Project[];
  devices: Device[];
  cards: Card[];
  live: boolean;
  toasts: ToastApi;
  go: (hash: string) => void;
  onMenu: () => void;
  pushOn: boolean | null;
  onNotify: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const active = useMemo(() => cards.filter((c) => bucket(c) !== 'done').sort(byUrgency), [cards]);
  const count = (b: Bucket) => active.filter((c) => bucket(c) === b).length;
  const counts = { all: active.length, you: count('you'), running: count('running'), failed: count('failed') };
  const shown = filter === 'all' ? active : active.filter((c) => bucket(c) === filter);
  const online = devices.some((d) => d.online);
  const today = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="m-screen">
      <header className="m-head">
        <div>
          <div className="m-date">{today}</div>
          <h1 className="m-title">Tổng quan</h1>
        </div>
        <div className="m-head-actions">
          <button
            className="m-icon-btn m-bell"
            onClick={onNotify}
            aria-label={pushOn ? 'Thông báo (đang bật)' : 'Bật thông báo'}
            title={pushOn ? 'Thông báo đang bật' : 'Bật thông báo khi việc xong'}
          >
            <span aria-hidden>{pushOn === false ? '🔕' : '🔔'}</span>
            {pushOn === false && <span className="m-bell-dot" aria-hidden />}
          </button>
          <button className="m-icon-btn" onClick={onMenu} aria-label="Menu">
            <span className={`dot ${online && live ? 'ok' : 'off'}`} aria-hidden />
            <span aria-hidden>☰</span>
          </button>
        </div>
      </header>

      <div className="m-stats">
        <button className={`m-stat warn${filter === 'you' ? ' on' : ''}`} onClick={() => setFilter(filter === 'you' ? 'all' : 'you')}>
          <strong>{counts.you}</strong>
          <span>Cần bạn</span>
        </button>
        <button className={`m-stat info${filter === 'running' ? ' on' : ''}`} onClick={() => setFilter(filter === 'running' ? 'all' : 'running')}>
          <strong>{counts.running}</strong>
          <span>Đang chạy</span>
        </button>
        <button className={`m-stat danger${filter === 'failed' ? ' on' : ''}`} onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')}>
          <strong>{counts.failed}</strong>
          <span>Lỗi</span>
        </button>
      </div>

      <div className="m-chips" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} className={`m-chip${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label} {counts[f.id]}
          </button>
        ))}
      </div>

      {!online && devices.length > 0 && (
        <p className="m-note warn">Máy chạy bridge đang offline: agent chưa nhận được việc mới cho tới khi máy bật lại.</p>
      )}

      <div className="m-list">
        {projects.length === 0 && (
          <div className="m-empty">
            <p>Chưa có bảng nào.</p>
            <p className="muted small">Ghép nối máy và tạo bảng ở chế độ bảng (trên máy tính), rồi quay lại đây.</p>
          </div>
        )}
        {projects.length > 0 && shown.length === 0 && (
          <div className="m-empty">
            <p>{filter === 'all' ? 'Chưa có việc nào.' : 'Không có việc nào ở mục này.'}</p>
            {filter === 'all' && <p className="muted small">Bấm "Việc mới" để giao việc cho agent.</p>}
          </div>
        )}
        {shown.map((c) => (
          <TaskItem key={c.id} card={c} project={projects.find((p) => p.id === c.projectId)} toasts={toasts} go={go} />
        ))}
      </div>

      <div className="m-bottom">
        <button className="m-cta" onClick={() => go('#new')} disabled={!projects.length}>
          <span aria-hidden>🎤</span> Việc mới
        </button>
      </div>
    </div>
  );
}

function TaskItem({ card, project, toasts, go }: { card: Card; project?: Project; toasts: ToastApi; go: (h: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const b = badge(card);
  const kind = bucket(card);
  const open = (suffix = '') => go(`#card/${card.id}${suffix}`);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toasts.info(ok);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const w = card.waiting;
  const q = w?.kind === 'question' ? splitOptions(w.text) : null;
  const reply = (text: string) =>
    run(() => api.reply(card.id, { messageId: w?.messageId, text }).then(() => setAnswer('')), 'Đã gửi trả lời.');

  return (
    <article className={`m-card tone-${b.tone}`}>
      <button className="m-card-main" onClick={() => open()}>
        <div className="m-card-top">
          <span className="m-card-project">{project?.name ?? 'Bảng'}</span>
          <span className={`m-badge ${b.tone}`}>
            <span aria-hidden>{b.icon}</span> {b.label}
          </span>
        </div>
        <div className="m-card-title">{card.title}</div>
        {kind === 'you' && card.status === 'review' && card.summary && <p className="m-card-ok">✓ {card.summary}</p>}
        {kind === 'failed' && card.error && <p className="m-card-err">{card.error.split('\n')[0]}</p>}
        {card.pr && card.pr.state === 'open' && (
          <p className={`m-card-pr ${ciSummary(card.pr).tone}`}>
            PR #{card.pr.number}
            {card.pr.draft ? ' · nháp' : ''} · {ciSummary(card.pr).label}
            {card.pr.mergeable === 'conflicting' ? ' · xung đột' : ''}
          </p>
        )}
        {card.preview?.status === 'running' && <p className="m-card-ok small">● Đang có bản xem trước{card.preview.url ? ' (mở được trên điện thoại)' : ''}</p>}
        <div className="m-meta">
          {AGENT_LABELS[card.agent]}
          {card.branch && (
            <>
              {' · '}
              <code>{card.branch}</code>
            </>
          )}
          {' · '}
          {timeAgo(card.updatedAt)}
        </div>
      </button>

      {w && w.kind !== 'question' && (
        <div className="m-callout">
          {w.kind === 'login' ? 'Agent cần đăng nhập: ' : w.kind === 'setup' ? 'Cần thiết lập: ' : 'Agent chờ xác nhận: '}
          {w.text.split('\n')[0]}
        </div>
      )}
      {q && <div className="m-callout">Agent hỏi: {q.question}</div>}

      <div className="m-actions">
        {card.status === 'review' && kind === 'you' && (
          <>
            <button className="m-btn" onClick={() => open('/preview')}>
              ↗ Xem trước
            </button>
            <button className="m-btn primary" onClick={() => open()}>
              Review
            </button>
          </>
        )}
        {q && q.options.length > 0 && (
          <div className="m-options">
            {q.options.map((o) => (
              <button key={o} className="m-btn" disabled={busy} onClick={() => reply(o)}>
                {o}
              </button>
            ))}
          </div>
        )}
        {q && q.options.length === 0 && (
          <form
            className="m-inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim()) reply(answer.trim());
            }}
          >
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Trả lời agent…" aria-label="Câu trả lời" />
            <button className="m-btn primary" disabled={busy || !answer.trim()}>
              Gửi
            </button>
          </form>
        )}
        {w?.kind === 'login' && (
          <button className="m-btn primary" onClick={() => open()}>
            🔑 Đăng nhập
          </button>
        )}
        {(w?.kind === 'prompt' || w?.kind === 'setup') && (
          <button className="m-btn primary" onClick={() => open()}>
            Xem và trả lời
          </button>
        )}
        {kind === 'failed' && (
          <>
            <button className="m-btn" onClick={() => open()}>
              Xem log
            </button>
            <button className="m-btn primary" disabled={busy} onClick={() => run(() => api.retry(card.id), 'Đã giao lại cho agent.')}>
              ↻ Chạy lại
            </button>
          </>
        )}
        {kind === 'running' && (
          <button className="m-btn" onClick={() => open()}>
            Xem tiến độ
          </button>
        )}
        {kind === 'todo' && (
          <>
            <button className="m-btn" onClick={() => open()}>
              Xem
            </button>
            <button
              className="m-btn primary"
              disabled={busy || project?.status !== 'ready'}
              onClick={() => run(() => api.start(card.id), 'Đã giao việc cho agent.')}
            >
              ▶ Giao việc
            </button>
          </>
        )}
      </div>
    </article>
  );
}
