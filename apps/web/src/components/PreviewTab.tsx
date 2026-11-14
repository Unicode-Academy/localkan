import { useEffect, useState } from 'react';
import { Camera, CircleStop, Play } from 'lucide-react';
import QRCode from 'qrcode';
import type { Card, PreviewInfo, Project, Screenshot } from '@localkan/protocol';
import { api } from '../api.ts';
import type { ToastApi } from './Toasts.tsx';

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost small"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Đã chép' : label}
    </button>
  );
}

/** Preview of one card's worktree. */
export function PreviewTab({ card, toasts }: { card: Card; toasts: ToastApi }) {
  return (
    <PreviewPanel
      preview={card.preview}
      intro='Bridge chạy dev server của dự án ngay trong worktree của thẻ (tự cài dependencies nếu thiếu). Bật "link từ xa" để mở được trên điện thoại khi bạn không ở cạnh máy.'
      start={(tunnel) => api.previewStart(card.id, tunnel)}
      stop={() => api.previewStop(card.id)}
      shoot={(path) => api.screenshots(card.id, path)}
      toasts={toasts}
    />
  );
}

/** Preview of the board's project folder itself (its checked-out branch, usually main). */
export function ProjectPreview({ project, toasts }: { project: Project; toasts: ToastApi }) {
  return (
    <PreviewPanel
      preview={project.preview}
      intro={`Chạy dev server ngay trong thư mục dự án (${project.repoPath}), tức nhánh đang checkout${
        project.baseRef ? ` (${project.baseRef})` : ''
      }: kết quả sau khi các thẻ đã merge.`}
      start={(tunnel) => api.projectPreviewStart(project.id, tunnel)}
      stop={() => api.projectPreviewStop(project.id)}
      shoot={(path) => api.projectScreenshots(project.id, path)}
      toasts={toasts}
    />
  );
}

/**
 * Live preview: the bridge runs the project's dev server and, when asked, a password-protected
 * ngrok link that works from a phone. Plus screenshots at phone and desktop sizes (taken with
 * headless Chrome on the bridge machine).
 */
function PreviewPanel({
  preview,
  intro,
  start: startPreview,
  stop: stopPreview,
  shoot: takeShots,
  toasts,
}: {
  preview: PreviewInfo | null;
  intro: string;
  start: (tunnel: boolean) => Promise<unknown>;
  stop: () => Promise<unknown>;
  shoot: (path: string) => Promise<{ shots: Screenshot[] }>;
  toasts: ToastApi;
}) {
  const [tunnel, setTunnel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [path, setPath] = useState('/');
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [shooting, setShooting] = useState(false);

  useEffect(() => {
    if (!preview?.url) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(preview.url, { margin: 1, width: 220 }).then(setQr, () => setQr(null));
  }, [preview?.url]);

  const start = async () => {
    setBusy(true);
    try {
      await startPreview(tunnel);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopPreview();
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shoot = async () => {
    setShooting(true);
    try {
      const r = await takeShots(path || '/');
      setShots(r.shots);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setShooting(false);
    }
  };

  const running = preview?.status === 'running';
  const starting = preview?.status === 'starting' || busy;

  return (
    <div className="preview-tab">
      <section className="preview-box">
        <div className="waiting-title">Xem trước</div>
        {!preview && !busy && <p className="muted small">{intro}</p>}

        {starting && (
          <p className="preview-progress">
            <span className="run run-starting">đang chuẩn bị</span> {preview?.message ?? 'Đang khởi động…'}
          </p>
        )}

        {preview?.status === 'error' && !busy && <pre className="screen error-text">{preview.message}</pre>}

        {running && (
          <div className="preview-live">
            {preview.url ? (
              <div className="preview-remote">
                {qr && <img className="qr" src={qr} alt="Mã QR mở link xem trước" width={180} height={180} />}
                <div className="preview-fields">
                  <div>
                    <span className="muted small">Link từ xa</span>
                    <div className="row wrap">
                      <a href={preview.url} target="_blank" rel="noreferrer" className="preview-url">
                        {preview.url}
                      </a>
                      <Copy text={preview.url} label="Chép" />
                    </div>
                  </div>
                  <div className="row wrap">
                    <span className="muted small">Tài khoản</span> <code>{preview.username}</code>
                    <span className="muted small">Mật khẩu</span> <code>{preview.password}</code>
                    {preview.password && <Copy text={preview.password} label="Chép mật khẩu" />}
                  </div>
                  <p className="muted small">
                    Quét mã QR bằng điện thoại. Lần đầu ngrok hiện trang cảnh báo: bấm "Visit Site", rồi nhập tài khoản và mật khẩu ở
                    trên.
                  </p>
                </div>
              </div>
            ) : (
              <p className="muted small">Đang chạy chỉ trên máy (không có link từ xa).</p>
            )}
            <p className="muted small">
              Trên máy chạy bridge: <code>{preview.localUrl}</code> · lệnh <code>{preview.command}</code>
            </p>
          </div>
        )}

        <div className="row wrap">
          {!running && (
            <>
              <label className="check">
                <input type="checkbox" checked={tunnel} onChange={(e) => setTunnel(e.target.checked)} disabled={starting} /> Mở link từ
                xa (ngrok, có mật khẩu)
              </label>
              <button className="btn primary" onClick={start} disabled={starting}>
                <Play /> Chạy xem trước
              </button>
            </>
          )}
          {running && !preview.url && (
            <button className="btn" onClick={() => startPreview(true).catch((e) => toasts.error(e.message))}>
              Mở link từ xa
            </button>
          )}
          {running && (
            <button className="btn" onClick={stop} disabled={busy}>
              <CircleStop /> Dừng
            </button>
          )}
        </div>
      </section>

      <section className="preview-box">
        <div className="waiting-title">Ảnh chụp màn hình</div>
        <p className="muted small">Chụp trang đang chạy ở khổ điện thoại và máy tính (tự chạy dev server nếu chưa chạy).</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            shoot();
          }}
        >
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/ hoặc /login" aria-label="Đường dẫn cần chụp" />
          <button className="btn primary" disabled={shooting}>
            {shooting ? (
              'Đang chụp…'
            ) : (
              <>
                <Camera /> Chụp
              </>
            )}
          </button>
        </form>
        {shots.length > 0 && (
          <div className="shots">
            {shots.map((s) => (
              <figure key={s.viewport} className={`shot shot-${s.viewport}`}>
                <a href={s.dataUrl} target="_blank" rel="noreferrer" download={`${s.viewport}.png`}>
                  <img src={s.dataUrl} alt={`Ảnh ${s.viewport} của ${s.url}`} />
                </a>
                <figcaption className="muted small">
                  {s.viewport === 'mobile' ? 'Điện thoại' : 'Máy tính'} · {s.width}×{s.height} · {s.url} ·{' '}
                  {new Date(s.takenAt).toLocaleTimeString('vi-VN')}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
