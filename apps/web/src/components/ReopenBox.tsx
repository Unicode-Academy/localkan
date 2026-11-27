import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Card } from '@localkan/protocol';
import { api } from '../api.ts';
import type { ToastApi } from './Toasts.tsx';

const PLACEHOLDER: Record<Card['mode'], string> = {
  act: 'Cần chỉnh gì thêm? Ví dụ: đổi màu nút sang cam, thêm kiểm tra số điện thoại.',
  ask: 'Muốn hỏi thêm gì về câu trả lời này?',
  plan: 'Muốn đổi gì trong kế hoạch?',
};

/** A finished card's follow-up: open it again and give the agent one more request. It works in
 *  a new worktree from the card's own work, with the card's handoff note. */
export function ReopenBox({ card, toasts }: { card: Card; toasts: ToastApi }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.reopen(card.id, text.trim());
      setText('');
      toasts.info('Đã mở lại thẻ và giao yêu cầu bổ sung cho agent.');
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="reopen">
      <div className="summary-head">Yêu cầu bổ sung</div>
      <p className="muted small">
        Cần chỉnh thêm? Agent làm tiếp ngay trong thẻ này: bắt đầu từ code của thẻ (nhánh của thẻ nếu chưa merge, còn không thì nhánh chính đã có
        nó) và đọc ghi chú bàn giao của lần trước. Không cần tạo thẻ mới.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={PLACEHOLDER[card.mode]} aria-label="Yêu cầu bổ sung" />
      <div className="row">
        <button className="btn primary" disabled={busy || !text.trim()} onClick={go}>
          <RotateCcw /> {busy ? 'Đang mở lại…' : 'Mở lại và giao cho agent'}
        </button>
      </div>
    </section>
  );
}
