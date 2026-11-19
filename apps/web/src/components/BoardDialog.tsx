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

      <TokenSettings project={project} toasts={toasts} />

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

/** What the board's agents may spend: lean Claude sessions and a budget per card. */
function TokenSettings({ project, toasts }: { project: Project; toasts: ToastApi }) {
  const [lean, setLean] = useState(project.leanAgents);
  const [usd, setUsd] = useState(project.budget.cardUsd === null ? '' : String(project.budget.cardUsd));
  const [stop, setStop] = useState(project.budget.stop);
  const [busy, setBusy] = useState(false);
  const cardUsd = usd.trim() === '' ? null : Number(usd.replace(',', '.'));
  const invalid = cardUsd !== null && !(Number.isFinite(cardUsd) && cardUsd > 0);
  const changed = lean !== project.leanAgents || cardUsd !== project.budget.cardUsd || (cardUsd !== null && stop !== project.budget.stop);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateProjectSettings(project.id, { leanAgents: lean, budget: { cardUsd, stop: cardUsd !== null && stop } });
      toasts.info('Đã lưu cài đặt tiết kiệm token.');
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form token-settings" onSubmit={save}>
      <strong>Tiết kiệm token</strong>
      <label className="check">
        <input type="checkbox" checked={lean} onChange={(e) => setLean(e.target.checked)} />
        <span>
          Chạy Claude gọn
          <span className="muted small">
            {' '}
            — không nạp MCP server và plugin cài chung trên máy (bớt khoảng 6K token mỗi lượt gọi). Skill và CLAUDE.md của dự án vẫn dùng. Tắt nếu agent cần
            các MCP/plugin đó. Áp dụng cho việc giao từ giờ.
          </span>
        </span>
      </label>
      <label>
        Ngân sách mỗi thẻ (USD, ước tính theo giá API)
        <input
          inputMode="decimal"
          value={usd}
          onChange={(e) => setUsd(e.target.value)}
          placeholder="Không giới hạn"
          aria-invalid={invalid}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={stop} disabled={cardUsd === null} onChange={(e) => setStop(e.target.checked)} />
        <span>
          Tự dừng agent khi thẻ vượt ngân sách
          <span className="muted small"> — nếu không, chỉ báo. Muốn chạy tiếp thì dùng "Yêu cầu sửa" hoặc tăng ngân sách.</span>
        </span>
      </label>
      {invalid && <p className="error-text small">Ngân sách phải là số lớn hơn 0, hoặc để trống.</p>}
      <div className="row">
        <button className="btn" disabled={busy || invalid || !changed}>
          Lưu
        </button>
      </div>
    </form>
  );
}
