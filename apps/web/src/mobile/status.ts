import type { Card } from '@localkan/protocol';

/** Where a card sits from the phone's point of view. */
export type Bucket = 'you' | 'running' | 'failed' | 'todo' | 'done';
export type Tone = 'warn' | 'info' | 'danger' | 'ok' | 'muted';

export function bucket(c: Card): Bucket {
  if (c.status === 'done') return 'done';
  if (c.status === 'todo') return 'todo';
  if (c.status === 'needs_input') return 'you';
  if (c.status === 'in_progress') return 'running';
  if (c.runState === 'failed' || c.runState === 'stopped') return 'failed';
  if (c.runState === 'running' || c.runState === 'starting') return 'running';
  return 'you';
}

const ORDER: Record<Bucket, number> = { you: 0, failed: 1, running: 2, todo: 3, done: 4 };

/** Things that need you first, then failures, running work and drafts; newest first within. */
export function byUrgency(a: Card, b: Card): number {
  return ORDER[bucket(a)] - ORDER[bucket(b)] || b.updatedAt.localeCompare(a.updatedAt);
}

export function badge(c: Card): { label: string; tone: Tone; icon: string } {
  switch (c.status) {
    case 'todo':
      return { label: 'Chưa giao', tone: 'muted', icon: '○' };
    case 'done':
      return { label: 'Đã xong', tone: 'ok', icon: '✓' };
    case 'in_progress':
      return { label: c.runState === 'starting' ? 'Đang khởi động' : 'Đang chạy', tone: 'info', icon: '●' };
    case 'needs_input':
      switch (c.waiting?.kind) {
        case 'login':
          return { label: 'Cần đăng nhập', tone: 'warn', icon: '🔑' };
        case 'question':
          return { label: 'Cần trả lời', tone: 'warn', icon: '?' };
        case 'setup':
          return { label: 'Cần thiết lập', tone: 'warn', icon: '⚙' };
        default:
          return { label: 'Cần xác nhận', tone: 'warn', icon: '!' };
      }
    case 'review':
      if (c.runState === 'failed') return { label: 'Lỗi', tone: 'danger', icon: '⚠' };
      if (c.runState === 'stopped') return { label: 'Đã dừng', tone: 'danger', icon: '■' };
      if (c.runState === 'running' || c.runState === 'starting') return { label: 'Đang chạy', tone: 'info', icon: '●' };
      return { label: 'Cần review', tone: 'warn', icon: '👁' };
  }
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

/** The bridge appends "Lựa chọn: a, b" to questions that come with options. */
export function splitOptions(text: string): { question: string; options: string[] } {
  const m = text.match(/\n?Lựa chọn: (.+)$/);
  if (!m) return { question: text, options: [] };
  const options = m[1]
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .slice(0, 6);
  return { question: text.slice(0, m.index).trim(), options };
}
