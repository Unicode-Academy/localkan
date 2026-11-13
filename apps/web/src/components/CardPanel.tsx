import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_LABELS,
  AGENTS,
  type AgentId,
  type Card,
  CARD_STATUS_LABELS,
  type CardMode,
  type DiffResult,
  type FinishAction,
  type LogLine,
  type Project,
  type ReviewComment,
  type TerminalKey,
} from '@localkan/protocol';
import { api } from '../api.ts';
import { DiffView } from './DiffView.tsx';
import { ImageAttachments, imagesFromClipboard, acceptImages } from './ImageAttachments.tsx';
import { ParentSelect } from './ParentSelect.tsx';
import { PreviewTab } from './PreviewTab.tsx';
import { RemoteBrowser } from './RemoteBrowser.tsx';
import { RunBadge } from './RunBadge.tsx';
import type { ToastApi } from './Toasts.tsx';
import { appendPhrase, VoiceButton } from './VoiceButton.tsx';

type Tab = 'log' | 'diff' | 'terminal' | 'task' | 'preview';

export function CardPanel({
  card,
  cards,
  project,
  log,
  setLog,
  onClose,
  toasts,
}: {
  card: Card;
  cards: Card[];
  project: Project;
  log: LogLine[];
  setLog: (cardId: string, lines: LogLine[]) => void;
  onClose: () => void;
  toasts: ToastApi;
}) {
  const defaultTab: Tab = card.status === 'todo' ? 'task' : card.status === 'review' ? 'diff' : 'log';
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [busy, setBusy] = useState(false);
  const started = card.status !== 'todo';

  // Load the bridge's stored log once when the panel opens.
  useEffect(() => {
    if (!started) return;
    api.log(card.id).then(
      (r) => setLog(card.id, r.lines),
      () => {},
    );
  }, [card.id, started, setLog]);

  // Jump to the diff when the agent finishes.
  const prevStatus = useRef(card.status);
  useEffect(() => {
    if (prevStatus.current !== card.status && card.status === 'review') setTab('diff');
    prevStatus.current = card.status;
  }, [card.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement) && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  return (
    <aside className="panel" aria-label={`Thẻ ${card.title}`}>
      <div className="panel-head">
        <div>
          <div className="panel-status">
            {CARD_STATUS_LABELS[card.status]} <RunBadge state={card.runState} />
          </div>
          <h2>{card.title}</h2>
          <div className="panel-meta">
            <span className={`agent agent-${card.agent}`}>{AGENT_LABELS[card.agent]}</span>
            {card.mode === 'ask' && <span className="tag">Hỏi</span>}
            {card.branch && <code>{card.branch}</code>}
            {card.prUrl && (
              <a href={card.prUrl} target="_blank" rel="noreferrer">
                Pull Request ↗
              </a>
            )}
          </div>
        </div>
        <button className="btn ghost icon" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>

      {card.error && <div className="banner error">{card.error}</div>}
      {card.summary && card.status !== 'todo' && (
        <div className="summary">
          <strong>Agent báo cáo:</strong> {card.summary}
        </div>
      )}

      {card.waiting && <WaitingBox card={card} cards={cards} project={project} toasts={toasts} busy={busy} run={run} />}

      <div className="actions">
        {card.status === 'todo' && (
          <>
            <button className="btn primary" disabled={busy || project.status !== 'ready'} onClick={() => run(() => api.start(card.id))}>
              ▶ Giao cho agent
            </button>
            <button
              className="btn ghost danger"
              disabled={busy}
              onClick={() => confirm('Xóa thẻ này?') && run(() => api.deleteCard(card.id).then(onClose))}
            >
              Xóa
            </button>
          </>
        )}
        {card.status === 'review' && (card.runState === 'failed' || card.runState === 'stopped') && (
          <button
            className="btn primary"
            disabled={busy}
            title="Giao lại nhiệm vụ ban đầu cho agent mới trong cùng worktree (giữ các thay đổi đã có)"
            onClick={() => run(() => api.retry(card.id))}
          >
            ↻ Chạy lại từ đầu
          </button>
        )}
        {(card.status === 'in_progress' || card.status === 'needs_input') && (
          <button className="btn" disabled={busy} onClick={() => confirm('Dừng agent của thẻ này?') && run(() => api.stop(card.id), 'Đã dừng agent.')}>
            ■ Dừng
          </button>
        )}
        {(card.status === 'done' ||
          (card.status === 'review' && card.runState !== 'running' && card.runState !== 'starting')) && (
          <button
            className="btn ghost danger"
            disabled={busy}
            onClick={() =>
              confirm(
                card.status === 'done'
                  ? 'Xóa thẻ khỏi bảng?'
                  : 'Xóa thẻ khỏi bảng? Thẻ chưa được Hoàn tất nên worktree và nhánh của nó vẫn còn trên máy. Muốn dọn luôn thì dùng Hoàn tất → Hủy thay đổi.',
              ) && run(() => api.deleteCard(card.id).then(onClose))
            }
          >
            Xóa thẻ
          </button>
        )}
      </div>

      <nav className="tabs" role="tablist">
        {(['task', 'log', 'diff', 'preview', 'terminal'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'on' : ''}
            onClick={() => setTab(t)}
            disabled={t !== 'task' && (!started || (t === 'preview' && card.status === 'done'))}
          >
            {{ task: 'Nhiệm vụ', log: 'Log', diff: 'Diff', preview: 'Xem trước', terminal: 'Terminal' }[t]}
            {t === 'preview' && card.preview?.status === 'running' && ' ●'}
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {tab === 'task' && <TaskTab card={card} cards={cards} toasts={toasts} />}
        {tab === 'log' && <LogTab log={log} />}
        {tab === 'diff' && <ReviewTab card={card} busy={busy} run={run} />}
        {tab === 'terminal' && <TerminalTab card={card} busy={busy} run={run} />}
        {tab === 'preview' && <PreviewTab card={card} toasts={toasts} />}
      </div>
    </aside>
  );
}

export type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

export function WaitingBox({
  card,
  cards,
  project,
  toasts,
  busy,
  run,
}: {
  card: Card;
  cards: Card[];
  project: Project;
  toasts: ToastApi;
  busy: boolean;
  run: Run;
}) {
  const [text, setText] = useState('');
  const w = card.waiting!;
  if (w.kind === 'login') {
    return (
      <div className="waiting-box login">
        <div className="waiting-title">Agent cần bạn đăng nhập</div>
        <p className="waiting-text">{w.text}</p>
        {w.url && (
          <p className="small">
            Trang: <code>{w.url}</code>
          </p>
        )}
        <RemoteBrowser project={project} cards={cards} toasts={toasts} initialPageId={w.pageId ?? null} loginOpen />
        <div className="row wrap">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api.reply(card.id, {
                    messageId: w.messageId,
                    text: 'Signed in: the reviewer completed the sign-in in the shared Orca browser tab. Reload the page and continue.',
                  }),
                'Đã báo agent làm tiếp',
              )
            }
          >
            ✓ Đã đăng nhập, cho agent làm tiếp
          </button>
        </div>
        <details>
          <summary className="small">Trả lời khác (ví dụ: bỏ qua phần cần đăng nhập)</summary>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Nhắn cho agent…" />
          <button
            className="btn"
            disabled={busy || !text.trim()}
            onClick={() => run(() => api.reply(card.id, { messageId: w.messageId, text }).then(() => setText('')))}
          >
            Gửi
          </button>
        </details>
      </div>
    );
  }
  if (w.kind === 'setup') {
    return (
      <div className="waiting-box">
        <div className="waiting-title">Cần thiết lập một lần trên máy chạy bridge</div>
        <p className="waiting-text">{w.text}</p>
        <button className="btn primary" disabled={busy} onClick={() => run(() => api.retry(card.id))}>
          Đã xong, thử lại
        </button>
      </div>
    );
  }
  if (w.kind === 'question') {
    return (
      <div className="waiting-box">
        <div className="waiting-title">Agent hỏi bạn</div>
        <p className="waiting-text">{w.text}</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Câu trả lời của bạn…" />
        <button
          className="btn primary"
          disabled={busy || !text.trim()}
          onClick={() => run(() => api.reply(card.id, { messageId: w.messageId, text }).then(() => setText('')))}
        >
          Gửi trả lời
        </button>
      </div>
    );
  }
  return (
    <div className="waiting-box">
      <div className="waiting-title">Agent đang chờ xác nhận trong terminal</div>
      {w.screen && <pre className="screen">{w.screen.join('\n')}</pre>}
      <div className="row wrap">
        <button
          className="btn primary"
          disabled={busy}
          title="Chọn lựa chọn đồng ý (Yes/Allow/Trust) trên màn hình agent"
          onClick={() => run(() => api.reply(card.id, { keys: ['approve'] }))}
        >
          Đồng ý
        </button>
        <button
          className="btn"
          disabled={busy}
          title="Chọn lựa chọn từ chối (No/Deny) trên màn hình agent"
          onClick={() => run(() => api.reply(card.id, { keys: ['reject'] }))}
        >
          Từ chối
        </button>
        <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.reply(card.id, { keys: ['enter'] }))}>
          Enter
        </button>
        <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.reply(card.id, { keys: ['esc'] }))}>
          Esc
        </button>
        <KeyButtons card={card} busy={busy} run={run} />
      </div>
    </div>
  );
}

function KeyButtons({ card, busy, run }: { card: Card; busy: boolean; run: Run }) {
  const send = (keys: TerminalKey[]) => run(() => api.reply(card.id, { keys }));
  return (
    <>
      <button className="btn ghost small" disabled={busy} onClick={() => send(['up'])} aria-label="Mũi tên lên">
        ↑
      </button>
      <button className="btn ghost small" disabled={busy} onClick={() => send(['down'])} aria-label="Mũi tên xuống">
        ↓
      </button>
      <button className="btn ghost small" disabled={busy} onClick={() => send(['tab'])}>
        Tab
      </button>
      <button className="btn ghost small" disabled={busy} onClick={() => send(['interrupt'])}>
        Ctrl-C
      </button>
    </>
  );
}

function TaskTab({ card, cards, toasts }: { card: Card; cards: Card[]; toasts: ToastApi }) {
  const editable = card.status === 'todo';
  const [title, setTitle] = useState(card.title);
  const [prompt, setPrompt] = useState(card.prompt);
  const [interim, setInterim] = useState('');
  const [agent, setAgent] = useState<AgentId>(card.agent);
  const [mode, setMode] = useState<CardMode>(card.mode);
  const [uploading, setUploading] = useState(false);
  const [parentCardId, setParentCardId] = useState<string | null>(card.parentCardId);
  const parent = card.parentCardId ? cards.find((c) => c.id === card.parentCardId) : null;
  const dirty =
    title !== card.title ||
    prompt !== card.prompt ||
    agent !== card.agent ||
    mode !== card.mode ||
    parentCardId !== card.parentCardId;

  // Images are saved immediately (no "save" step), like attaching a file to an email.
  const upload = async (files: File[]) => {
    setUploading(true);
    try {
      await api.uploadAttachments(card.id, files);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  if (!editable) {
    return (
      <div className="task-view">
        {parent && (
          <p className="muted small">
            ↳ Làm tiếp từ thẻ <strong>{parent.title}</strong>
          </p>
        )}
        <pre className="prompt">{card.prompt || '(không có mô tả)'}</pre>
        {card.attachments.length > 0 && <ImageAttachments existing={card.attachments} onError={toasts.error} />}
        {card.worktreePath && (
          <p className="muted small">
            Worktree: <code>{card.worktreePath}</code>
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      className="form"
      onPaste={(e) => {
        const pasted = imagesFromClipboard(e);
        if (!pasted.length) return;
        e.preventDefault();
        const { ok, error } = acceptImages(pasted, card.attachments.length);
        if (ok.length) upload(ok);
        if (error) toasts.error(error);
      }}
    >
      <label>
        Tiêu đề
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="field">
        <div className="field-head">
          <span>Mô tả cho agent</span>
          <VoiceButton onFinal={(t) => setPrompt((p) => appendPhrase(p, t))} onInterim={setInterim} onError={toasts.error} />
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={10} />
        {interim && <p className="interim">{interim}</p>}
      </div>
      <div className="field">
        <span className="field-label">Ảnh minh họa {uploading && <span className="muted small">· đang tải lên…</span>}</span>
        <ImageAttachments
          existing={card.attachments}
          onAdd={upload}
          onRemoveExisting={(a) => api.deleteAttachment(a.id).catch((e) => toasts.error(e.message))}
          onError={toasts.error}
          disabled={uploading}
        />
      </div>
      <ParentSelect cards={cards} value={parentCardId} onChange={setParentCardId} excludeId={card.id} />
      <div className="row">
        <select value={agent} onChange={(e) => setAgent(e.target.value as AgentId)} aria-label="Agent">
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {AGENT_LABELS[a]}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as CardMode)} aria-label="Chế độ">
          <option value="act">Làm (sửa code)</option>
          <option value="ask">Hỏi (chỉ đọc)</option>
        </select>
      </div>
      <button
        className="btn"
        disabled={!dirty}
        onClick={() =>
          api
            .updateCard(card.id, { title, prompt, agent, mode, parentCardId })
            .then(() => toasts.info('Đã lưu.'), (e) => toasts.error(e.message))
        }
      >
        Lưu thay đổi
      </button>
    </div>
  );
}

export function LogTab({ log }: { log: LogLine[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <pre
      className="log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {log.length === 0 && <span className="muted">Chưa có log.</span>}
      {log.map((l) => (
        <div key={l.seq} className={`logline from-${l.source}`}>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function ReviewTab({ card, busy, run }: { card: Card; busy: boolean; run: Run }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [feedback, setFeedback] = useState('');
  const [finishing, setFinishing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.diff(card.id).then(setDiff, (e) => setError(e.message));
  }, [card.id]);
  useEffect(load, [load, card.updatedAt]);

  const canReview = card.status === 'review';
  return (
    <div className="review">
      <div className="row">
        <button className="btn ghost small" onClick={load}>
          ↻ Tải lại diff
        </button>
        {diff && (
          <span className="muted small">
            so với <code>{diff.baseRef}</code> · {diff.files.length} file
          </span>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {diff && (
        <DiffView
          diff={diff}
          comments={comments}
          onAddComment={(c) => setComments((prev) => [...prev, c])}
          onRemoveComment={(i) => setComments((prev) => prev.filter((_, j) => j !== i))}
        />
      )}
      {canReview && (
        <div className="review-actions">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="Nhận xét chung hoặc yêu cầu sửa thêm (tùy chọn)…"
          />
          <div className="row wrap">
            <button
              className="btn"
              disabled={busy || (!feedback.trim() && !comments.length)}
              onClick={() =>
                run(
                  () => api.followup(card.id, feedback, comments).then(() => {
                    setComments([]);
                    setFeedback('');
                  }),
                  'Đã gửi yêu cầu sửa cho agent.',
                )
              }
            >
              Yêu cầu sửa ({comments.length} nhận xét)
            </button>
            <div className="spacer" />
            <button className="btn primary" disabled={busy} onClick={() => setFinishing(true)}>
              Hoàn tất…
            </button>
          </div>
        </div>
      )}
      {finishing && canReview && <FinishBox card={card} busy={busy} run={run} onCancel={() => setFinishing(false)} />}
    </div>
  );
}

const FINISH_OPTIONS: { action: FinishAction; label: string; hint: string }[] = [
  { action: 'commit', label: 'Commit vào nhánh', hint: 'Commit thay đổi vào nhánh của thẻ, dọn worktree, giữ nhánh.' },
  { action: 'pr', label: 'Tạo Pull Request', hint: 'Commit, push nhánh và tạo PR bằng gh (repo cần có remote).' },
  { action: 'merge', label: 'Merge vào nhánh gốc', hint: 'Commit rồi merge vào nhánh gốc trong repo chính (repo chính phải sạch).' },
  { action: 'discard', label: 'Hủy thay đổi', hint: 'Xóa worktree và nhánh của thẻ. Không hoàn tác được.' },
];

export function FinishBox({ card, busy, run, onCancel }: { card: Card; busy: boolean; run: Run; onCancel: () => void }) {
  const [action, setAction] = useState<FinishAction>(card.mode === 'ask' ? 'discard' : 'commit');
  const [message, setMessage] = useState(card.title);
  return (
    <div className="finish-box">
      <div className="waiting-title">Hoàn tất thẻ</div>
      {FINISH_OPTIONS.map((o) => (
        <label key={o.action} className="radio">
          <input type="radio" name="finish" checked={action === o.action} onChange={() => setAction(o.action)} />
          <span>
            <strong>{o.label}</strong>
            <span className="muted small"> — {o.hint}</span>
          </span>
        </label>
      ))}
      {action !== 'discard' && (
        <label>
          Commit message
          <input value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button
          className={`btn ${action === 'discard' ? 'danger' : 'primary'}`}
          disabled={busy}
          onClick={() =>
            (action !== 'discard' || confirm('Xóa toàn bộ thay đổi của thẻ này?')) &&
            run(() => api.finish(card.id, action, message).then(onCancel), 'Đã hoàn tất thẻ.')
          }
        >
          Xác nhận
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Hủy
        </button>
      </div>
    </div>
  );
}

function TerminalTab({ card, busy, run }: { card: Card; busy: boolean; run: Run }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [auto, setAuto] = useState(true);

  const load = useCallback(() => {
    api.screen(card.id).then(
      (r) => {
        setLines(r.lines);
        setError(null);
      },
      (e) => setError(e.message),
    );
  }, [card.id]);

  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, auto]);

  return (
    <div className="terminal-tab">
      <div className="row">
        <button className="btn ghost small" onClick={load}>
          ↻ Làm mới
        </button>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Tự làm mới
        </label>
      </div>
      {error && <p className="error-text">{error}</p>}
      <pre className="screen big">{lines ? lines.join('\n') : 'Đang tải…'}</pre>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api.reply(card.id, { text }).then(() => setText('')));
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Gõ vào terminal của agent rồi Enter…" />
        <button className="btn" disabled={busy || !text}>
          Gửi
        </button>
      </form>
      <div className="row wrap">
        <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.reply(card.id, { keys: ['enter'] }))}>
          Enter
        </button>
        <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.reply(card.id, { keys: ['esc'] }))}>
          Esc
        </button>
        <KeyButtons card={card} busy={busy} run={run} />
      </div>
    </div>
  );
}
