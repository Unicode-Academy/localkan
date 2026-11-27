import type { LogLine } from '@localkan/protocol';

/** One turn of the exchange between the agent and you, as the card's log recorded it. */
export interface ExchangeItem {
  seq: number;
  ts: string;
  who: 'agent' | 'you';
  kind: 'report' | 'ask' | 'answer' | 'request';
  text: string;
  /** Recorded by an older bridge, which kept only part of it. */
  partial?: boolean;
}

const TYPED = new Set(['report', 'ask', 'answer', 'request']);

/**
 * The agent's reports and questions and your answers and requests, in order. Logs written
 * before these had their own kinds hold them as system lines: read those by their wording.
 */
export function exchange(log: LogLine[]): ExchangeItem[] {
  const out: ExchangeItem[] = [];
  const typedNear = (i: number, kind: string, span: number) =>
    log.slice(Math.max(0, i - span), i + span + 1).some((l) => l.source === kind);
  log.forEach((l, i) => {
    const base = { seq: l.seq, ts: l.ts };
    if (TYPED.has(l.source)) {
      const kind = l.source as ExchangeItem['kind'];
      out.push({ ...base, kind, who: kind === 'report' || kind === 'ask' ? 'agent' : 'you', text: l.text });
      return;
    }
    if (l.source !== 'system') return;
    const t = l.text.replace(/^▸\s*/, '');
    const after = (prefix: string) => (t.startsWith(prefix) ? t.slice(prefix.length).trim() : null);
    const asked = after('Agent hỏi:');
    if (asked !== null) return void out.push({ ...base, who: 'agent', kind: 'ask', text: asked });
    const answered = after('Bạn trả lời:') ?? after('Bạn gõ vào terminal:');
    if (answered !== null) return void out.push({ ...base, who: 'you', kind: 'answer', text: answered });
    if (t.startsWith('Gửi yêu cầu sửa cho agent')) {
      return void out.push({ ...base, who: 'you', kind: 'request', text: 'Yêu cầu sửa (bản cũ chưa lưu nội dung).', partial: true });
    }
    // A reopen: newer bridges add a typed `request` line right after with the whole request.
    const reopened = t.match(/^Mở lại thẻ \(lần (\d+)\) với yêu cầu bổ sung:\s*(.*)$/s);
    if (reopened && !typedNear(i, 'request', 3)) {
      return void out.push({ ...base, who: 'you', kind: 'request', text: `Yêu cầu bổ sung (lần ${reopened[1]}):\n${reopened[2]}` });
    }
    if (t.startsWith('Agent báo đã xong') && !typedNear(i, 'report', 2)) {
      out.push({ ...base, who: 'agent', kind: 'report', text: 'Agent báo đã xong (log không có nội dung báo cáo; xem ghi chú bàn giao bên dưới).', partial: true });
    }
  });
  return out;
}

export const EXCHANGE_LABELS: Record<ExchangeItem['kind'], string> = {
  report: 'Agent báo cáo',
  ask: 'Agent hỏi',
  answer: 'Bạn trả lời',
  request: 'Bạn yêu cầu',
};
