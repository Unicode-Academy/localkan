import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { Card, Device, Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

/** A board's own settings: its name, and deleting it. */
export function BoardDialog({
  project,
  device,
  cards,
  onClose,
  toasts,
}: {
  project: Project;
  device: Device | null;
  /** The board's cards (to say what deleting removes, and to block it while agents work). */
  cards: Card[];
  onClose: () => void;
  toasts: ToastApi;
}) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const working = cards.filter((c) => c.status === 'in_progress' || c.status === 'needs_input').length;

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === project.name) return;
    setBusy(true);
    try {
      await api.renameProject(project.id, name.trim());
      toasts.info('Đã đổi tên bảng.');
      onClose();
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const what = cards.length ? `${cards.length} thẻ của bảng sẽ bị xóa khỏi Localkan.` : 'Bảng chưa có thẻ nào.';
    if (
      !confirm(
        `Xóa bảng "${project.name}"?\n\n${what} Thư mục dự án trên máy không bị đụng tới; worktree và nhánh của các thẻ chưa hoàn tất vẫn còn trên máy.\n\nKhông hoàn tác được.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      toasts.info(`Đã xóa bảng "${project.name}".`);
      onClose();
    } catch (err) {
      toasts.error((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="Cài đặt bảng" onClose={onClose}>
      <form className="form" onSubmit={rename}>
        <label>
          Tên bảng
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </label>
        <p className="muted small">
          Thư mục: <code>{project.repoPath}</code>
          {device && <> · Máy: {device.name}</>}
        </p>
        <div className="row">
          <button className="btn primary" disabled={busy || !name.trim() || name.trim() === project.name}>
            Lưu tên
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Đóng
          </button>
        </div>
      </form>

      <section className="danger-zone">
        <strong>Xóa bảng</strong>
        <p className="muted small">
          Xóa bảng và {cards.length} thẻ của nó khỏi Localkan. Thư mục dự án, repo và các nhánh trên máy vẫn giữ nguyên.
        </p>
        {working > 0 && (
          <p className="small warn-text">
            Còn {working} việc đang chạy hoặc chờ bạn: dừng các việc đó trước khi xóa bảng.
          </p>
        )}
        <div className="row">
          <button className="btn danger" disabled={busy || working > 0} onClick={remove}>
            <Trash2 /> Xóa bảng
          </button>
        </div>
      </section>
    </Dialog>
  );
}
