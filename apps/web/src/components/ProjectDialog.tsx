import { useEffect, useState, type FormEvent } from 'react';
import type { Device, FolderInfo, Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

function FolderStatus({ info }: { info: FolderInfo }) {
  if (!info.exists) return <p className="folder-status new">Thư mục chưa có: Localkan sẽ tạo mới và git init.</p>;
  if (info.isGitRepo) return <p className="folder-status ok">✓ Repo git</p>;
  if (info.isEmpty) return <p className="folder-status new">Thư mục trống: Localkan sẽ tự git init và tạo commit đầu tiên.</p>;
  if (info.childRepos?.length) {
    return (
      <p className="folder-status ok">
        ✓ Bảng nhiều repo: {info.childRepos.map((r) => `${r}/`).join(', ')}. Mỗi việc có worktree của từng repo trong cùng một thư
        mục; thư mục này không cần git init.
      </p>
    );
  }
  return (
    <p className="folder-status warn">
      Thư mục đã có file nhưng chưa phải repo git. Hãy chạy <code>git init && git add -A && git commit -m "Initial commit"</code> trong
      thư mục đó trước, hoặc chọn thư mục khác.
    </p>
  );
}

export function ProjectDialog({
  devices,
  onClose,
  onCreated,
  onPair,
  toasts,
}: {
  devices: Device[];
  onClose: () => void;
  onCreated: (p: Project) => void;
  onPair: () => void;
  toasts: ToastApi;
}) {
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [deviceId, setDeviceId] = useState(devices.find((d) => d.online)?.id ?? devices[0]?.id ?? '');
  const [info, setInfo] = useState<FolderInfo | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const device = devices.find((d) => d.id === deviceId);

  // Describe a typed path once the user pauses.
  useEffect(() => {
    const path = repoPath.trim();
    if (!path || !device?.online) {
      setInfo(null);
      return;
    }
    const t = setTimeout(() => {
      api.inspectFolder(deviceId, path).then(setInfo, () => setInfo(null));
    }, 500);
    return () => clearTimeout(t);
  }, [repoPath, deviceId, device?.online]);

  const browse = async () => {
    setPicking(true);
    try {
      const res = await api.pickFolder(deviceId, repoPath.trim() || undefined);
      if (res.path) {
        setRepoPath(res.path);
        setInfo(res.info);
        if (!name.trim()) setName(folderName(res.path));
      }
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setPicking(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api.createProject({ name: name.trim() || folderName(repoPath) || 'Bảng mới', deviceId, repoPath });
      if (p.status === 'error') toasts.error(`Đã tạo bảng nhưng chưa đăng ký được repo: ${p.error}`);
      onCreated(p);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!devices.length) {
    return (
      <Dialog title="Bảng mới" onClose={onClose}>
        <p>Bạn cần ghép nối ít nhất một máy trước, vì repo và agent chạy trên máy đó.</p>
        <button className="btn primary" onClick={onPair}>
          Ghép nối máy
        </button>
      </Dialog>
    );
  }

  const blocked = info !== null && info.exists && !info.isGitRepo && !info.isEmpty && !info.childRepos?.length;

  return (
    <Dialog title="Bảng mới" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Máy
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} {d.online ? '' : '(offline)'}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Thư mục dự án trên máy đó</span>
          <div className="row">
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/ban/code/my-app"
              required
              aria-label="Đường dẫn thư mục dự án"
            />
            <button
              type="button"
              className="btn"
              onClick={browse}
              disabled={picking || !device?.online}
              title={device?.online ? `Mở hộp chọn thư mục trên ${device.name}` : 'Máy đang offline'}
            >
              {picking ? 'Đang chờ chọn…' : 'Browse…'}
            </button>
          </div>
          {picking && (
            <p className="muted small">
              Hộp chọn thư mục đã mở trên <strong>{device?.name}</strong>. Có thể bấm "New Folder" trong hộp đó để tạo thư mục mới.
            </p>
          )}
          {info && <FolderStatus info={info} />}
        </div>
        <label>
          Tên bảng
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mặc định: tên thư mục" />
        </label>
        <p className="muted small">
          Bridge sẽ đăng ký repo với Orca và tạo một terminal điều phối. Server chỉ lưu thông tin quản lý (tên bảng, đường dẫn,
          thẻ). Diff và log được chuyển tiếp để hiển thị nhưng không được lưu trên server.
        </p>
        <button className="btn primary" disabled={busy || !deviceId || blocked}>
          {busy ? 'Đang đăng ký với Orca…' : 'Tạo bảng'}
        </button>
      </form>
    </Dialog>
  );
}
