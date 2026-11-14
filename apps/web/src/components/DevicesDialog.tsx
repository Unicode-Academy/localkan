import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Device } from '@localkan/protocol';
import { AGENT_LABELS, AGENTS } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

export function DevicesDialog({
  devices,
  onClose,
  onChanged,
  toasts,
}: {
  devices: Device[];
  onClose: () => void;
  onChanged: () => void;
  toasts: ToastApi;
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);

  const newCode = () => api.pairingCode().then(setCode, (e) => toasts.error(e.message));
  const remove = (d: Device) => {
    if (
      !confirm(
        `Gỡ máy "${d.name}"? Bridge trên máy đó sẽ bị ngắt và phải ghép nối lại. Các bảng của máy này sẽ tự chuyển sang máy kết nối tiếp theo.`,
      )
    )
      return;
    api.removeDevice(d.id).then(onChanged, (e) => toasts.error(e.message));
  };

  return (
    <Dialog title="Máy chạy bridge" onClose={onClose}>
      {devices.length === 0 && <p className="muted">Chưa có máy nào. Tạo mã ghép nối rồi nhập vào Localkan Bridge.</p>}
      <ul className="device-list">
        {devices.map((d) => (
          <li key={d.id}>
            <div className="device-head">
              <span className={`dot ${d.online ? 'ok' : 'off'}`} />
              <strong>{d.name}</strong>
              <span className="muted">{d.online ? 'online' : 'offline'}</span>
              <div className="spacer" />
              <button className="btn ghost small" onClick={() => remove(d)}>
                Gỡ
              </button>
            </div>
            {d.info && (
              <div className="device-info">
                <span>Bridge {d.info.version}</span>
                <span className={d.info.orca.reachable ? 'ok-text' : 'error-text'}>
                  Orca {d.info.orca.reachable ? d.info.orca.version ?? 'sẵn sàng' : `chưa chạy${d.info.orca.error ? `: ${d.info.orca.error}` : ''}`}
                </span>
                {AGENTS.map((a) => (
                  <span key={a} className={d.info?.agents[a] ? 'ok-text' : 'muted'}>
                    {AGENT_LABELS[a]} {d.info?.agents[a] ? <Check /> : <X />}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="pairing">
        {code ? (
          <>
            <p>Nhập mã này vào Localkan Bridge trên máy của bạn (hết hạn sau 10 phút):</p>
            <div className="pairing-code">{code.code}</div>
            <p className="muted small">
              Hoặc chạy bản headless: <code>lk-bridge pair --server {location.origin} --code {code.code}</code>
            </p>
          </>
        ) : (
          <button className="btn primary" onClick={newCode}>
            Tạo mã ghép nối
          </button>
        )}
      </div>
    </Dialog>
  );
}
