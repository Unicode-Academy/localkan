import type { CardMode } from '@localkan/protocol';

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
