import type { Card } from '@localkan/protocol';
import { Circle, CircleAlert, CircleCheck, CircleStop, Eye, Hourglass, KeyRound, LoaderCircle, MessageCircle, MessageCircleQuestion, Settings, TriangleAlert, type LucideIcon } from 'lucide-react';

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

/**
 * Things that need you first, then failures and running work (newest first), then the to-do
 * list in the Kanban's own order: board by board, top to bottom, so a new task goes last.
 */
export function byUrgency(projectIds: string[] = []): (a: Card, b: Card) => number {
  const board = (c: Card) => {
    const i = projectIds.indexOf(c.projectId);
    return i < 0 ? projectIds.length : i;
  };
  return (a, b) => {
    const order = ORDER[bucket(a)] - ORDER[bucket(b)];
    if (order) return order;
    if (bucket(a) === 'todo') {
      return board(a) - board(b) || a.position - b.position || a.createdAt.localeCompare(b.createdAt);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  };
}

export function badge(c: Card): { label: string; tone: Tone; Icon: LucideIcon } {
  switch (c.status) {
    case 'todo':
      return { label: 'Chưa giao', tone: 'muted', Icon: Circle };
    case 'done':
      return { label: 'Đã xong', tone: 'ok', Icon: CircleCheck };
    case 'in_progress':
      return { label: c.runState === 'starting' ? 'Đang khởi động' : 'Đang chạy', tone: 'info', Icon: LoaderCircle };
    case 'needs_input':
      switch (c.waiting?.kind) {
        case 'login':
          return { label: 'Cần đăng nhập', tone: 'warn', Icon: KeyRound };
        case 'question':
          return { label: 'Cần trả lời', tone: 'warn', Icon: MessageCircleQuestion };
        case 'setup':
          return { label: 'Cần thiết lập', tone: 'warn', Icon: Settings };
        case 'limit':
          return { label: 'Hết hạn mức', tone: 'warn', Icon: Hourglass };
        case 'idle':
          return { label: 'Chờ bạn nhắn', tone: 'warn', Icon: MessageCircle };
        default:
          return { label: 'Cần xác nhận', tone: 'warn', Icon: CircleAlert };
      }
    case 'review':
      if (c.runState === 'failed') return { label: 'Lỗi', tone: 'danger', Icon: TriangleAlert };
      if (c.runState === 'stopped') return { label: 'Đã dừng', tone: 'danger', Icon: CircleStop };
      if (c.runState === 'running' || c.runState === 'starting') return { label: 'Đang chạy', tone: 'info', Icon: LoaderCircle };
      return { label: 'Cần review', tone: 'warn', Icon: Eye };
  }
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}
