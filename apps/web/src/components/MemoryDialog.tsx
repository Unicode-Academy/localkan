import { useEffect, useState } from 'react';
import { HANDOFF_STATUS_LABELS, type HandoffNote, type HandoffStatus, type Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

const PLACEHOLDER = `Ví dụ:
- Next.js App Router, TypeScript, Tailwind v4, shadcn/ui.
- Dùng pnpm, không dùng npm.
- Component đặt trong src/components, tên PascalCase.
- Đã chốt: xác thực bằng NextAuth, DB là Postgres qua Drizzle.`;

/**
 * Project memory and handoff notes. Both live on the bridge machine in the repo's
 * git-ignored .localkan/ folder; the server only relays them.
 */
export function MemoryDialog({ project, onClose, toasts }: { project: Project; onClose: () => void; toasts: ToastApi }) {
  const [tab, setTab] = useState<'memory' | 'handoffs'>('memory');
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [path, setPath] = useState('');
  const [notes, setNotes] = useState<HandoffNote[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.memory(project.id).then(
      (m) => {
        setContent(m.content);
        setSaved(m.content);
        setPath(m.path);
      },
      (e) => setError(e.message),
    );
    api.handoffs(project.id).then(
      (h) => setNotes(h.handoffs),
      () => setNotes([]),
    );
  }, [project.id]);

  const save = async () => {
    if (content === null) return;
    setBusy(true);
    try {
      await api.saveMemory(project.id, content);
      setSaved(content);
      toasts.info('Đã lưu bộ nhớ dự án.');
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Bộ nhớ · ${project.name}`} onClose={onClose}>
      <nav className="tabs plain" role="tablist">
        <button role="tab" aria-selected={tab === 'memory'} className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>
          Bộ nhớ dự án
        </button>
        <button role="tab" aria-selected={tab === 'handoffs'} className={tab === 'handoffs' ? 'on' : ''} onClick={() => setTab('handoffs')}>
          Bàn giao {notes ? `(${notes.length})` : ''}
        </button>
      </nav>

      {error && <p className="error-text">{error}</p>}

      {tab === 'memory' && (
        <div className="form">
          <p className="muted small">
            Quy ước, công nghệ, quyết định đã chốt… Mọi thẻ mới đều nhận nội dung này. Lưu tại máy chạy bridge:{' '}
            <code>{path || '.localkan/memory.md'}</code> (git bỏ qua, không bị commit).
          </p>
          <textarea
            value={content ?? ''}
            onChange={(e) => setContent(e.target.value)}
            placeholder={content === null ? 'Đang tải…' : PLACEHOLDER}
            rows={14}
            disabled={content === null}
          />
          <div className="row">
            <button className="btn primary" onClick={save} disabled={busy || content === null || content === saved}>
              Lưu
            </button>
            {content !== null && content !== saved && <span className="muted small">Chưa lưu</span>}
          </div>
        </div>
      )}

      {tab === 'handoffs' && (
        <div className="handoffs">
          <p className="muted small">
            Agent viết ghi chú này khi xong việc. Thẻ mới nhận tóm tắt của các thẻ gần đây (bỏ qua thẻ đã hủy), và nhận đầy đủ ghi
            chú của thẻ được chọn ở "Làm tiếp từ thẻ".
          </p>
          {notes === null && <p className="muted">Đang tải…</p>}
          {notes?.length === 0 && <p className="muted">Chưa có ghi chú bàn giao nào.</p>}
          {notes?.map((n) => (
            <article key={n.cardId} className={`handoff ${n.status === 'discarded' ? 'dim' : ''}`}>
              <button className="handoff-head" onClick={() => setOpen((o) => (o === n.cardId ? null : n.cardId))} aria-expanded={open === n.cardId}>
                <strong>{n.title}</strong>
                <span className={`tag status-${n.status}`}>{HANDOFF_STATUS_LABELS[n.status as HandoffStatus] ?? n.status}</span>
                <span className="muted small">{new Date(n.updatedAt).toLocaleString('vi-VN')}</span>
              </button>
              {open === n.cardId && <pre className="prompt">{n.content}</pre>}
            </article>
          ))}
        </div>
      )}
    </Dialog>
  );
}
