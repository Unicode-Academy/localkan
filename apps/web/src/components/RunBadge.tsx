import type { RunState } from '@localkan/protocol';

const LABELS: Record<RunState, string> = {
  idle: 'chờ',
  starting: 'đang khởi động',
  running: 'đang chạy',
  waiting: 'chờ bạn',
  succeeded: 'xong',
  failed: 'lỗi',
  stopped: 'đã dừng',
};

export function RunBadge({ state }: { state: RunState }) {
  if (state === 'idle') return null;
  return <span className={`run run-${state}`}>{LABELS[state]}</span>;
}
