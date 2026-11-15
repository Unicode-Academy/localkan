import type { Card, CardMode } from '@localkan/protocol';

/** What each kind of card asks of the agent, for pickers. */
export const MODE_LABELS: Record<CardMode, string> = {
  act: 'Làm (sửa code)',
  ask: 'Hỏi (chỉ đọc)',
  plan: 'Lập kế hoạch',
};

/** Short tag shown on cards that do not change code. */
export const MODE_TAGS: Partial<Record<CardMode, string>> = { ask: 'Hỏi', plan: 'Kế hoạch' };

/** Wording of the description field for each kind of card. */
export const MODE_PROMPT: Record<CardMode, { label: string; placeholder: string }> = {
  act: {
    label: 'Mô tả cho agent',
    placeholder: 'Làm gì, ở đâu, ràng buộc nào, kiểm tra thế nào là xong… Có thể bấm nút Nói để đọc.',
  },
  ask: { label: 'Câu hỏi', placeholder: 'Bạn muốn biết gì về dự án? Agent đọc code và trả lời, không sửa file nào.' },
  plan: {
    label: 'Bạn muốn làm gì?',
    placeholder:
      'Mục tiêu, mong muốn, giới hạn… Agent đọc code, hỏi lại khi chưa rõ, rồi lập danh sách việc để bạn nhập vào To Do.',
  },
};

/** What "Xong" asks before closing a question or a planning card (its worktree is removed). */
export function closeConfirm(card: Card): string {
  if (card.mode !== 'plan') return 'Đóng thẻ này?';
  if (card.planImport) return 'Đóng thẻ kế hoạch? Các việc đã nhập vẫn ở To Do.';
  return 'Bạn chưa nhập việc nào của kế hoạch này vào To Do.\n\nVẫn đóng thẻ? Kế hoạch được lưu lại trong thẻ: mở thẻ ở cột Done để xem và nhập sau.';
}
