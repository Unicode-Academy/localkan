import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { DEFAULT_NOTIFY_PREFS, type NotifyKind, type NotifyPrefs } from '@localkan/protocol';
import { api } from '../api.ts';
import { currentSubscription, disablePush, enablePush, isIOS, pushSupport, savePrefs } from '../push.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

const KINDS: { kind: NotifyKind; label: string; hint: string }[] = [
  { kind: 'done', label: 'Việc xong', hint: 'Agent làm xong, chờ bạn review (kèm tóm tắt).' },
  { kind: 'input', label: 'Cần bạn xử lý', hint: 'Agent hỏi, cần đăng nhập hoặc cần bạn xác nhận.' },
  { kind: 'failed', label: 'Việc bị lỗi', hint: 'Agent báo thất bại hoặc không chạy được.' },
];

/** Turn push notifications on or off for this device and pick which events it gets. */
export function NotificationsDialog({ onClose, toasts }: { onClose: () => void; toasts: ToastApi }) {
  const support = pushSupport();
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api.pushConfig();
        if (alive) setDevices(cfg.devices);
        const sub = support.ok ? await currentSubscription() : null;
        if (sub && Notification.permission === 'granted') {
          const r = await api.pushLookup(sub.endpoint);
          // Subscribed in the browser but unknown to the server: re-register it.
          const p = r.prefs ?? (await savePrefs({}));
          if (alive) setPrefs(p);
        }
      } catch (err) {
        if (alive) toasts.error((err as Error).message);
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
    // Runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    act(async () => {
      const r = await enablePush(prefs ?? DEFAULT_NOTIFY_PREFS);
      setPrefs(r.prefs);
      setDevices((d) => (d ?? 0) + 1);
      toasts.info('Đã bật thông báo trên thiết bị này.');
    });

  const disable = () =>
    act(async () => {
      await disablePush();
      setPrefs(null);
      setDevices((d) => (d ? d - 1 : d));
      toasts.info('Đã tắt thông báo trên thiết bị này.');
    });

  const toggle = (kind: NotifyKind, on: boolean) =>
    act(async () => {
      setPrefs(await savePrefs({ [kind]: on }));
    });

  const test = () =>
    act(async () => {
      const sub = await currentSubscription();
      if (!sub) throw new Error('Thiết bị này chưa bật thông báo.');
      await api.pushTest(sub.endpoint);
      toasts.info('Đã gửi thông báo thử. Nếu không thấy, kiểm tra chế độ Không làm phiền.');
    });

  return (
    <Dialog title="Thông báo" onClose={onClose}>
      <p className="muted small">
        Báo cho bạn khi agent làm xong, khi cần bạn trả lời hoặc đăng nhập, và khi việc bị lỗi, kể cả lúc không mở Localkan. Bấm
        vào thông báo để mở đúng việc đó.
      </p>

      {!support.ok && support.reason === 'ios-browser' && (
        <div className="notice">
          <strong>Trên iPhone/iPad:</strong> bấm nút Chia sẻ (ô vuông có mũi tên lên) → <em>Thêm vào Màn hình chính</em>, mở
          Localkan từ biểu tượng đó, rồi quay lại đây bật thông báo. iOS chỉ cho web app trên màn hình chính nhận thông báo (iOS
          16.4 trở lên).
        </div>
      )}
      {!support.ok && support.reason === 'insecure' && (
        <div className="notice">
          Thông báo cần trang chạy qua <strong>HTTPS</strong> (hoặc localhost). Khi đưa Localkan lên server, dùng tên miền có
          HTTPS (ví dụ nginx có SSL đứng trước, như trong deploy/nginx/localkan.conf.example).
        </div>
      )}
      {!support.ok && support.reason === 'unsupported' && (
        <div className="notice">Trình duyệt này chưa hỗ trợ thông báo đẩy. Hãy dùng Chrome, Edge, Firefox hoặc Safari bản mới.</div>
      )}

      {support.ok && checking && <p className="muted small">Đang kiểm tra…</p>}

      {support.ok && !checking && !prefs && (
        <div className="row wrap">
          <button className="btn primary" disabled={busy} onClick={enable}>
            <Bell /> Bật thông báo trên thiết bị này
          </button>
          {isIOS() && <span className="muted small">iPhone sẽ hỏi quyền gửi thông báo, chọn Cho phép.</span>}
        </div>
      )}

      {support.ok && prefs && (
        <>
          <div className="notify-kinds">
            {KINDS.map((k) => (
              <label key={k.kind} className="m-toggle">
                <span>
                  {k.label}
                  <small>{k.hint}</small>
                </span>
                <input type="checkbox" role="switch" checked={prefs[k.kind]} disabled={busy} onChange={(e) => toggle(k.kind, e.target.checked)} />
              </label>
            ))}
          </div>
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={test}>
              Gửi thử
            </button>
            <div className="spacer" />
            <button className="btn ghost danger" disabled={busy} onClick={disable}>
              Tắt trên thiết bị này
            </button>
          </div>
        </>
      )}

      {devices !== null && (
        <p className="muted small">
          {devices === 0 ? 'Chưa có thiết bị nào bật thông báo.' : `${devices} thiết bị đang nhận thông báo.`} Mỗi điện thoại, máy tính
          bật riêng.
        </p>
      )}
      <p className="muted small">
        Nội dung thông báo (tên việc, tóm tắt ngắn) được mã hóa đầu cuối; dịch vụ push của Google, Apple hay Mozilla chỉ chuyển
        tiếp, không đọc được.
      </p>
    </Dialog>
  );
}
