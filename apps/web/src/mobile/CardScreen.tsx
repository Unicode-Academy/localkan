import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AGENT_LABELS,
  type Card,
  type DiffResult,
  type LogLine,
  type Project,
  type ReviewComment,
  type Screenshot,
} from '@localkan/protocol';
import { api } from '../api.ts';
import { FinishBox, LogTab, WaitingBox, type Run } from '../components/CardPanel.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { ciSummary, PrPanel } from '../components/PrPanel.tsx';
import type { ToastApi } from '../components/Toasts.tsx';
import { appendPhrase, VoiceButton } from '../components/VoiceButton.tsx';
import { badge, bucket, timeAgo } from './status.ts';

export function CardScreen({
  card,
  project,
  cards,
  log,
  setLog,
  toasts,
  startPreview,
  onBack,
  onFull,
}: {
  card: Card;
  project: Project;
  cards: Card[];
  log: LogLine[];
  setLog: (cardId: string, lines: LogLine[]) => void;
  toasts: ToastApi;
  /** Opened from "Xem trước": start the preview if it is not running yet. */
  startPreview: boolean;
  onBack: () => void;
  onFull: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run: Run = async (fn, ok) => {
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

  const started = card.status !== 'todo';
  useEffect(() => {
    if (!started) return;
    api.log(card.id).then(
      (r) => setLog(card.id, r.lines),
      () => {},
    );
  }, [card.id, started, setLog]);

  const b = badge(card);
  const kind = bucket(card);
  const reviewable = card.status === 'review' && kind === 'you';
  const heading =
    card.status === 'review'
      ? kind === 'failed'
        ? 'Việc bị lỗi'
        : 'Review thay đổi'
      : card.status === 'needs_input'
        ? 'Cần bạn xử lý'
        : card.status === 'in_progress'
          ? 'Đang làm'
          : card.status === 'todo'
            ? 'Việc chưa giao'
            : 'Đã xong';

  return (
    <div className="m-screen">
      <header className="m-bar">
        <button className="m-icon-btn" onClick={onBack} aria-label="Quay lại">
          ←
        </button>
        <h1>{heading}</h1>
        <button className="m-icon-btn" onClick={onFull} aria-label="Chi tiết đầy đủ" title="Chi tiết đầy đủ (terminal, nhiệm vụ…)">
          ⋯
        </button>
      </header>

      <div className="m-detail">
        <span className={`m-badge ${b.tone}`}>
          <span aria-hidden>{b.icon}</span> {b.label}
        </span>
        <h2 className="m-detail-title">{card.title}</h2>
        <div className="m-meta">
          {project.name} · {AGENT_LABELS[card.agent]} · {timeAgo(card.updatedAt)}
          {card.branch && (
            <>
              {' · '}
              <code>{card.branch}</code>
            </>
          )}
        </div>

        {card.error && <div className="banner error">{card.error}</div>}

        {card.status === 'needs_input' && card.waiting && (
          <WaitingBox card={card} cards={cards} project={project} toasts={toasts} busy={busy} run={run} />
        )}

        {reviewable && <Review card={card} project={project} toasts={toasts} busy={busy} run={run} startPreview={startPreview} />}

        {(card.status === 'in_progress' || card.status === 'needs_input' || kind === 'failed' || kind === 'running') && (
          <section className="m-section">
            <div className="m-section-head">
              <span>Tiến độ</span>
              {(card.status === 'in_progress' || card.status === 'needs_input') && (
                <button className="m-btn small" disabled={busy} onClick={() => confirm('Dừng agent của việc này?') && run(() => api.stop(card.id), 'Đã dừng agent.')}>
                  ■ Dừng
                </button>
              )}
            </div>
            <LogTab log={log} />
          </section>
        )}

        {kind === 'failed' && (
          <div className="m-row">
            <button className="m-btn primary" disabled={busy} onClick={() => run(() => api.retry(card.id), 'Đã giao lại cho agent.')}>
              ↻ Chạy lại từ đầu
            </button>
            <button
              className="m-btn danger"
              disabled={busy}
              onClick={() => confirm('Xóa worktree và nhánh của việc này?') && run(() => api.finish(card.id, 'discard', ''), 'Đã hủy và xóa nhánh.')}
            >
              Hủy và xóa nhánh
            </button>
          </div>
        )}

        {card.status === 'todo' && (
          <section className="m-section">
            <div className="m-section-head">Yêu cầu</div>
            <p className="m-prewrap">{card.prompt || card.title}</p>
            <div className="m-row">
              <button className="m-btn primary" disabled={busy || project.status !== 'ready'} onClick={() => run(() => api.start(card.id), 'Đã giao việc cho agent.')}>
                ▶ Giao cho agent
              </button>
              <button className="m-btn danger" disabled={busy} onClick={() => confirm('Xóa việc này?') && run(() => api.deleteCard(card.id).then(onBack))}>
                Xóa
              </button>
            </div>
          </section>
        )}

        {card.status === 'done' && (
          <section className="m-section">
            {card.summary && <p>{card.summary}</p>}
            {card.prUrl && (
              <a className="m-btn" href={card.prUrl} target="_blank" rel="noreferrer">
                ↗ Mở Pull Request
              </a>
            )}
          </section>
        )}

        <button className="m-link" onClick={onFull}>
          Mở chi tiết đầy đủ (nhiệm vụ, terminal, xem trước…)
        </button>
      </div>
    </div>
  );
}

/** Review: preview with a phone link and screenshot, the agent's report, changed files, and
 *  the decision (request changes, merge, or reject). */
function Review({
  card,
  project,
  toasts,
  busy,
  run,
  startPreview,
}: {
  card: Card;
  project: Project;
  toasts: ToastApi;
  busy: boolean;
  run: Run;
  startPreview: boolean;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [asking, setAsking] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(() => {
    setDiffError(null);
    api.diff(card.id).then(setDiff, (e) => setDiffError(e.message));
  }, [card.id]);
  useEffect(load, [load, card.updatedAt]);

  const isAsk = card.mode === 'ask';
  const prFlow = !isAsk && (project.git.flow === 'pr' || !!card.pr);
  const base = card.pr?.base || project.git.baseBranch || project.baseRef || 'main';
  const mergePr = () => {
    const pr = card.pr;
    const ci = pr ? ciSummary(pr) : null;
    const warn =
      pr && pr.checks.failed > 0
        ? `\n\nCẢNH BÁO: CI đang lỗi (${pr.checks.failing.join(', ')}).`
        : pr && pr.checks.pending > 0
          ? '\n\nCI vẫn đang chạy.'
          : '';
    const what = pr ? `PR #${pr.number}` : 'nhánh này (Localkan sẽ mở PR trước)';
    const pipeline = pr && pr.checks.total > 0 ? ' CI/CD của repo sẽ chạy từ đó.' : '';
    if (!confirm(`Merge ${what} vào ${base} trên GitHub?${pipeline}${ci && pr && pr.checks.total > 0 ? ` (${ci.label})` : ''}${warn}`)) return;
    run(() => api.finish(card.id, 'merge_pr', card.title), 'Đã merge PR trên GitHub.');
  };
  const answer = diff ? addedText(diff.patch, '.localkan/answer.md') : null;
  const files = diff?.files.filter((f) => !(isAsk && f.path === '.localkan/answer.md')) ?? [];
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <>
      {prFlow && <PrPanel card={card} project={project} toasts={toasts} />}
      {!isAsk && <PreviewBlock card={card} toasts={toasts} autoStart={startPreview} />}

      {card.summary && (
        <section className="m-section">
          <div className="m-section-head">Agent báo cáo</div>
          <p className="m-prewrap">{card.summary}</p>
        </section>
      )}

      {isAsk && answer && (
        <section className="m-section">
          <div className="m-section-head">Câu trả lời</div>
          <div className="m-prewrap m-answer">{answer}</div>
        </section>
      )}

      <section className="m-section">
        <div className="m-section-head">
          <span>
            {diff ? `${files.length} file thay đổi` : 'Thay đổi'}
            {diff && files.length > 0 && (
              <span className="muted small">
                {' '}
                · <span className="add">+{adds}</span> <span className="del">−{dels}</span>
              </span>
            )}
          </span>
          <button className="m-btn small" onClick={load}>
            ↻
          </button>
        </div>
        {diffError && <p className="error-text small">{diffError}</p>}
        {!diff && !diffError && <p className="muted small">Đang tải…</p>}
        {diff && files.length === 0 && <p className="muted small">Không có file nào thay đổi.</p>}
        <ul className="m-files">
          {files.slice(0, 12).map((f) => (
            <li key={f.path}>
              <span className={`m-file-status ${f.status}`} aria-hidden>
                {f.status === 'added' || f.status === 'untracked' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M'}
              </span>
              <code className="m-file-path">{f.path}</code>
              <span className="small">
                <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
              </span>
            </li>
          ))}
          {files.length > 12 && <li className="muted small">và {files.length - 12} file khác</li>}
        </ul>
        {diff && files.length > 0 && (
          <button className="m-link" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? 'Ẩn diff' : `Xem diff chi tiết${comments.length ? ` (${comments.length} nhận xét)` : ''}`}
          </button>
        )}
        {showDiff && diff && (
          <DiffView
            diff={diff}
            comments={comments}
            onAddComment={(c) => setComments((prev) => [...prev, c])}
            onRemoveComment={(i) => setComments((prev) => prev.filter((_, j) => j !== i))}
          />
        )}
      </section>

      {more && <FinishBox card={card} busy={busy} run={run} onCancel={() => setMore(false)} flow={prFlow ? 'pr' : project.git.flow} />}

      <div className="m-bottom m-decide">
        <div className="m-row">
          <button className="m-btn big" disabled={busy} onClick={() => setAsking(true)}>
            🎤 Yêu cầu sửa{comments.length ? ` (${comments.length})` : ''}
          </button>
          {isAsk ? (
            <button className="m-btn big primary" disabled={busy} onClick={() => run(() => api.finish(card.id, 'discard', ''), 'Đã đóng việc.')}>
              ✓ Xong
            </button>
          ) : prFlow ? (
            <button className="m-btn big primary" disabled={busy} onClick={mergePr}>
              ⑂ Merge PR
            </button>
          ) : project.git.flow === 'push' ? (
            <button
              className="m-btn big primary"
              disabled={busy}
              onClick={() =>
                confirm(`Merge vào ${base} (bản mới nhất trên origin) và push lên remote?`) &&
                run(() => api.finish(card.id, 'merge_push', card.title), `Đã merge và push lên ${base}.`)
              }
            >
              ⑂ Merge &amp; push
            </button>
          ) : (
            <button
              className="m-btn big primary"
              disabled={busy}
              onClick={() =>
                confirm(`Merge thay đổi vào nhánh gốc của dự án?`) && run(() => api.finish(card.id, 'merge', card.title), 'Đã merge.')
              }
            >
              ⑂ Merge
            </button>
          )}
        </div>
        <div className="m-row m-row-links">
          {!isAsk && (
            <button className="m-link danger" disabled={busy} onClick={() => confirm('Xóa toàn bộ thay đổi, worktree và nhánh của việc này?') && run(() => api.finish(card.id, 'discard', ''), 'Đã hủy và xóa nhánh.')}>
              Hủy và xóa nhánh
            </button>
          )}
          <button className="m-link" onClick={() => setMore((v) => !v)}>
            {more ? 'Ẩn cách khác' : prFlow ? 'Cách khác…' : 'Cách khác (commit, PR)…'}
          </button>
        </div>
      </div>

      {asking && (
        <RequestChanges
          comments={comments}
          toasts={toasts}
          onClose={() => setAsking(false)}
          onSend={(text) =>
            run(
              () =>
                api.followup(card.id, text, comments).then(() => {
                  setComments([]);
                  setAsking(false);
                }),
              'Đã gửi yêu cầu sửa cho agent.',
            )
          }
          busy={busy}
        />
      )}
    </>
  );
}

function PreviewBlock({ card, toasts, autoStart }: { card: Card; toasts: ToastApi; autoStart: boolean }) {
  const preview = card.preview;
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [shooting, setShooting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const triedStart = useRef(false);
  const triedShot = useRef(false);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      await api.previewStart(card.id, true);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setStarting(false);
    }
  }, [card.id, toasts]);

  const shoot = useCallback(async () => {
    setShooting(true);
    try {
      const r = await api.screenshots(card.id, '/');
      setShot(r.shots.find((s) => s.viewport === 'mobile') ?? r.shots[0] ?? null);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setShooting(false);
    }
  }, [card.id, toasts]);

  // "Xem trước" from the overview: start it once if nothing is running.
  useEffect(() => {
    if (autoStart && !preview && !triedStart.current) {
      triedStart.current = true;
      start();
    }
  }, [autoStart, preview, start]);

  // Once the preview runs, grab a phone-size screenshot so the page is visible at a glance.
  useEffect(() => {
    if (preview?.status === 'running' && !shot && !triedShot.current) {
      triedShot.current = true;
      shoot();
    }
  }, [preview?.status, shot, shoot]);

  useEffect(() => {
    if (!preview?.url) return setQr(null);
    QRCode.toDataURL(preview.url, { margin: 1, width: 200 }).then(setQr, () => setQr(null));
  }, [preview?.url]);

  const running = preview?.status === 'running';
  const busyStarting = starting || preview?.status === 'starting';

  return (
    <section className="m-section m-preview">
      <div className="m-shot">
        {shot ? (
          <a href={shot.dataUrl} target="_blank" rel="noreferrer">
            <img src={shot.dataUrl} alt={`Ảnh trang ${shot.url} ở khổ điện thoại`} />
          </a>
        ) : (
          <div className="m-shot-empty">
            <span aria-hidden>🖼</span>
            <span>
              {shooting
                ? 'Đang chụp màn hình…'
                : busyStarting
                  ? (preview?.message ?? 'Đang khởi động xem trước…')
                  : running
                    ? 'Chưa có ảnh chụp'
                    : 'Chưa chạy xem trước'}
            </span>
          </div>
        )}
      </div>
      {preview?.status === 'error' && <p className="error-text small">{preview.message}</p>}
      {running && preview.url && <code className="m-url">{preview.url.replace(/^https?:\/\//, '')}</code>}

      {running && preview.url ? (
        <>
          <a className="m-btn big" href={preview.url} target="_blank" rel="noreferrer">
            ↗ Mở và thử trên điện thoại
          </a>
          <div className="m-cred">
            <span>
              Tài khoản <code>{preview.username}</code>
            </span>
            <span>
              Mật khẩu <code>{showPass ? preview.password : '••••••••'}</code>
            </span>
            <button className="m-btn small" onClick={() => setShowPass((v) => !v)}>
              {showPass ? 'Ẩn' : 'Hiện'}
            </button>
            {preview.password && (
              <button className="m-btn small" onClick={() => navigator.clipboard?.writeText(preview.password!).then(() => toasts.info('Đã chép mật khẩu.'))}>
                Chép
              </button>
            )}
          </div>
          <details className="m-more">
            <summary>Mã QR (mở trên máy khác)</summary>
            {qr && <img className="qr" src={qr} alt="Mã QR của link xem trước" width={160} height={160} />}
          </details>
        </>
      ) : running ? (
        <button className="m-btn big" disabled={busyStarting} onClick={start}>
          Mở link từ xa
        </button>
      ) : (
        <button className="m-btn big" disabled={busyStarting} onClick={start}>
          {busyStarting ? 'Đang chuẩn bị…' : '▶ Chạy xem trước'}
        </button>
      )}
      <div className="m-row m-row-links">
        {running && (
          <button className="m-link" disabled={shooting} onClick={shoot}>
            {shooting ? 'Đang chụp…' : '📸 Chụp lại'}
          </button>
        )}
        {running && (
          <button className="m-link" onClick={() => api.previewStop(card.id).catch((e) => toasts.error(e.message))}>
            ■ Dừng xem trước
          </button>
        )}
      </div>
    </section>
  );
}

function RequestChanges({
  comments,
  toasts,
  busy,
  onClose,
  onSend,
}: {
  comments: ReviewComment[];
  toasts: ToastApi;
  busy: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [interim, setInterim] = useState('');
  return (
    <div className="m-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Yêu cầu sửa">
        <div className="m-sheet-head">
          <strong>Yêu cầu sửa</strong>
          <button className="m-icon-btn" onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </div>
        <textarea
          className="m-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Cần sửa gì? Ví dụ: nút thanh toán bị che trên iPhone nhỏ, đẩy lên trên."
          autoFocus
        />
        {interim && <p className="interim">{interim}</p>}
        <VoiceButton big onFinal={(t) => setText((p) => appendPhrase(p, t))} onInterim={setInterim} onError={toasts.error} />
        {comments.length > 0 && <p className="muted small">Kèm {comments.length} nhận xét trên diff.</p>}
        <button className="m-cta" disabled={busy || (!text.trim() && !comments.length)} onClick={() => onSend(text.trim())}>
          Gửi cho agent
        </button>
      </div>
    </div>
  );
}

/** Text a patch adds to one file (used to show the answer of an "ask" card). */
function addedText(patch: string, path: string): string | null {
  const chunk = patch.split(/^diff --git /m).find((c) => c.includes(` b/${path}`) || c.startsWith(`a/${path} `));
  if (!chunk) return null;
  const lines = chunk
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  return lines.length ? lines.join('\n') : null;
}
