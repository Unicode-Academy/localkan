import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { BrowserAction, BrowserResult, BrowserShot, BrowserTab, Card, Project } from '@localkan/protocol';
import { api } from '../api.ts';
import type { ToastApi } from './Toasts.tsx';

/**
 * Remote view of the shared browser (Orca's built-in browser on the bridge machine): a
 * screenshot you can tap, a box to type into the focused field, keys, and a quick sign-in
 * form. Passwords typed here go to the bridge and straight into the page; the server does not
 * store them and the agent never sees them.
 */
export function RemoteBrowser({
  project,
  cards,
  toasts,
  initialPageId,
  loginOpen = false,
}: {
  project: Project;
  cards: Card[];
  toasts: ToastApi;
  initialPageId?: string | null;
  loginOpen?: boolean;
}) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [pageId, setPageId] = useState<string | null>(initialPageId ?? null);
  const [shot, setShot] = useState<BrowserShot | null>(null);
  const [busy, setBusy] = useState<string | null>('Đang tải…');
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [secret, setSecret] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [tapAt, setTapAt] = useState<{ x: number; y: number } | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const urlFocused = useRef(false);

  const act = useCallback(
    async (action: BrowserAction, label: string): Promise<BrowserResult | null> => {
      setBusy(label);
      try {
        const r = await api.browser(project.id, action);
        if (r.tabs) setTabs(r.tabs);
        if (r.shot !== undefined) setShot(r.shot);
        if (r.shot) {
          const s = r.shot;
          setPageId(s.pageId);
          // Keep the tab list's labels in step with where the tab is now.
          setTabs((ts) => ts.map((t) => (t.pageId === s.pageId ? { ...t, url: s.url, title: s.title } : t)));
        }
        setMessage(r.message ?? null);
        return r;
      } catch (err) {
        toasts.error((err as Error).message);
        return null;
      } finally {
        setBusy(null);
        setTapAt(null);
      }
    },
    [project.id, toasts],
  );

  // First load: the tab list, then a screenshot of the requested (or most relevant) tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await act({ kind: 'tabs' }, 'Đang tải…');
      if (cancelled || !r?.tabs) return;
      const pick =
        (initialPageId && (r.tabs.find((t) => t.pageId === initialPageId)?.pageId ?? initialPageId)) ||
        r.tabs.find((t) => t.active && (t.main || !t.worktreePath))?.pageId ||
        r.tabs[0]?.pageId ||
        null;
      setPageId(pick);
      if (pick) await act({ kind: 'shot', pageId: pick }, 'Đang chụp…');
    })();
    return () => {
      cancelled = true;
    };
  }, [act, initialPageId]);

  useEffect(() => {
    if (shot && !urlFocused.current) setUrl(shot.url);
  }, [shot]);

  const label = (t: BrowserTab) => {
    const owner = t.main ? 'main' : t.cardId ? (cards.find((c) => c.id === t.cardId)?.title ?? 'thẻ') : 'chung';
    return `[${owner}] ${t.title || t.url}`;
  };

  const onTap = (e: MouseEvent<HTMLImageElement>) => {
    if (!shot || !pageId || busy) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    setTapAt({ x: fx * 100, y: fy * 100 });
    act({ kind: 'tap', pageId, x: fx * shot.width, y: fy * shot.height }, 'Đang chạm…');
  };

  const go = (e: { preventDefault(): void }, newTab: boolean) => {
    e.preventDefault();
    if (!url.trim()) return;
    if (newTab || !pageId) act({ kind: 'open', url: url.trim() }, 'Đang mở tab…');
    else act({ kind: 'goto', pageId, url: url.trim() }, 'Đang mở trang…');
  };

  const typeText = async (e: FormEvent) => {
    e.preventDefault();
    if (!pageId || !text) return;
    const r = await act({ kind: 'type', pageId, text }, 'Đang gõ…');
    if (r) setText('');
  };

  const login = async (e: FormEvent) => {
    e.preventDefault();
    if (!pageId) return;
    const r = await act(
      { kind: 'login', pageId, username: username || undefined, password: password || undefined, otp: otp || undefined },
      'Đang đăng nhập…',
    );
    // Never keep secrets around longer than needed.
    setPassword('');
    setOtp('');
    if (r) setMessage(r.message ?? null);
  };

  const key = (k: string) => pageId && act({ kind: 'key', pageId, key: k }, `Đang bấm ${k}…`);
  const current = tabs.find((t) => t.pageId === pageId);

  return (
    <div className="rb">
      <div className="row wrap rb-toolbar">
        <select
          value={pageId ?? ''}
          onChange={(e) => {
            setPageId(e.target.value || null);
            if (e.target.value) act({ kind: 'shot', pageId: e.target.value }, 'Đang chụp…');
          }}
          aria-label="Chọn tab"
          className="rb-tabs"
        >
          {!tabs.length && <option value="">Chưa có tab nào</option>}
          {pageId && !current && <option value={pageId}>Tab của agent</option>}
          {tabs.map((t) => (
            <option key={t.pageId} value={t.pageId}>
              {label(t)}
            </option>
          ))}
        </select>
        <button className="btn ghost small" disabled={!!busy} onClick={() => act({ kind: 'tabs' }, 'Đang tải…')} title="Tải lại danh sách tab">
          Cập nhật tab
        </button>
        {pageId && (
          <button
            className="btn ghost small"
            disabled={!!busy}
            onClick={async () => {
              const r = await act({ kind: 'close', pageId }, 'Đang đóng tab…');
              const next = r?.tabs?.[0]?.pageId ?? null;
              setPageId(next);
              if (next) act({ kind: 'shot', pageId: next }, 'Đang chụp…');
            }}
            title="Đóng tab này"
          >
            ✕ Đóng tab
          </button>
        )}
      </div>

      <form className="row rb-toolbar" onSubmit={(e) => go(e, false)}>
        <button type="button" className="btn ghost small" disabled={!pageId || !!busy} onClick={() => pageId && act({ kind: 'back', pageId }, 'Đang quay lại…')} aria-label="Quay lại">
          ←
        </button>
        <button type="button" className="btn ghost small" disabled={!pageId || !!busy} onClick={() => pageId && act({ kind: 'reload', pageId }, 'Đang tải lại…')} aria-label="Tải lại trang" title="Tải lại trang">
          ↻
        </button>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => (urlFocused.current = true)}
          onBlur={() => (urlFocused.current = false)}
          placeholder="https://… hoặc localhost:3000"
          aria-label="Địa chỉ trang"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button className="btn small" disabled={!!busy || !url.trim()}>
          Đi
        </button>
        <button type="button" className="btn ghost small" disabled={!!busy || !url.trim()} onClick={(e) => go(e, true)}>
          + Tab mới
        </button>
      </form>

      <div className={`rb-screen${zoom ? ' zoom' : ''}`}>
        {shot ? (
          <div className="rb-frame">
            <img
              src={shot.dataUrl}
              alt={`Ảnh trang ${shot.title || shot.url}`}
              onClick={onTap}
              title="Chạm để bấm vào trang"
              draggable={false}
            />
            {tapAt && <span className="rb-tap" style={{ left: `${tapAt.x}%`, top: `${tapAt.y}%` }} />}
          </div>
        ) : (
          <p className="muted small rb-empty">
            {busy ? busy : 'Chưa có tab nào. Nhập địa chỉ ở trên rồi bấm "+ Tab mới".'}
          </p>
        )}
        {busy && shot && <span className="rb-busy">{busy}</span>}
      </div>
      {message && <p className="small rb-message">{message}</p>}

      <div className="row wrap rb-toolbar">
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => key('Enter')}>
          Enter
        </button>
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => key('Tab')}>
          Tab
        </button>
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => key('Backspace')} aria-label="Xóa lùi">
          ⌫
        </button>
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => key('Escape')}>
          Esc
        </button>
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => pageId && act({ kind: 'scroll', pageId, dy: -500 }, 'Đang cuộn…')}>
          ↑ Cuộn
        </button>
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => pageId && act({ kind: 'scroll', pageId, dy: 500 }, 'Đang cuộn…')}>
          ↓ Cuộn
        </button>
        <button className="btn ghost small" disabled={!pageId || !!busy} onClick={() => pageId && act({ kind: 'shot', pageId }, 'Đang chụp…')}>
          📷 Ảnh mới
        </button>
        <label className="check small">
          <input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} /> Phóng to
        </label>
      </div>

      <form className="row rb-toolbar" onSubmit={typeText}>
        <input
          type={secret ? 'password' : 'text'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Gõ vào ô đang chọn trên trang (chạm vào ô trước)"
          aria-label="Nội dung cần gõ"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <label className="check small" title="Ẩn chữ khi gõ mật khẩu">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Ẩn
        </label>
        <button className="btn small" disabled={!pageId || !!busy || !text}>
          Gõ
        </button>
      </form>

      <details className="rb-login" open={loginOpen}>
        <summary>Đăng nhập nhanh</summary>
        <form className="rb-login-form" onSubmit={login} autoComplete="off">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Tài khoản hoặc email"
            aria-label="Tài khoản"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mật khẩu"
            aria-label="Mật khẩu"
            autoComplete="new-password"
          />
          <input
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            placeholder="Mã xác minh (nếu có)"
            aria-label="Mã xác minh"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <button className="btn primary" disabled={!pageId || !!busy || (!username && !password && !otp)}>
            Điền và đăng nhập
          </button>
        </form>
        <p className="muted small">
          Localkan tự tìm ô tài khoản, mật khẩu và mã trên trang, gõ vào rồi bấm Enter. Thông tin chỉ được chuyển tới máy chạy
          bridge và gõ thẳng vào trang: không lưu trên server, không ghi log, agent không nhìn thấy. Trang lạ thì chạm vào ô
          rồi dùng ô "Gõ" (bật "Ẩn" khi gõ mật khẩu).
        </p>
      </details>
    </div>
  );
}
