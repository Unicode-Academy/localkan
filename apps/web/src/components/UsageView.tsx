import { useMemo } from 'react';
import { CircleDollarSign } from 'lucide-react';
import { formatTokens, formatUsd, summarizeUsage, type Card, type Project } from '@localkan/protocol';

/** Above this, every further step of the agent re-reads a lot: better to split the work. */
export const CONTEXT_WARN = 150_000;

const live = (c: Card) => c.status === 'in_progress' || c.status === 'needs_input' || c.status === 'review';

/** A card's cost on its board tile: "$0.84". Nothing until measured. */
export function CostTag({ card }: { card: Card }) {
  const s = useMemo(() => summarizeUsage([card.usage]), [card.usage]);
  if (!card.usage || card.usage.unsupported || s.tokens === 0) return null;
  const partial = s.unpriced.length > 0;
  const ctx = live(card) ? card.usage.contextTokens : undefined;
  return (
    <>
      <span
        className={`tag cost-tag${card.overBudgetAt ? ' over' : ''}`}
        title={`Chi phí AI ước tính theo giá API: ${formatUsd(s.usd)}${partial ? ' (chưa gồm model chưa có giá)' : ''} · ${formatTokens(s.tokens)} token${card.overBudgetAt ? ' · đã vượt ngân sách của bảng' : ''}`}
      >
        {partial && s.usd === 0 ? `${formatTokens(s.tokens)} tk` : formatUsd(s.usd)}
      </span>
      {ctx ? (
        <span
          className={`tag ctx-tag${ctx > CONTEXT_WARN ? ' warn' : ''}`}
          title={`Context hiện tại: mỗi bước agent đọc lại khoảng ${formatTokens(ctx)} token${ctx > CONTEXT_WARN ? '. Đã lớn: phần việc còn lại nên tách sang thẻ mới.' : ''}`}
        >
          ctx {formatTokens(ctx)}
        </span>
      ) : null}
    </>
  );
}

/** What the card's agent spent: total, then per model. */
export function UsageSection({ card, project }: { card: Card; project?: Project }) {
  const s = useMemo(() => summarizeUsage([card.usage]), [card.usage]);
  if (card.status === 'todo') return null;
  const u = card.usage;
  const ctx = live(card) ? u?.contextTokens : undefined;
  let body;
  if (!u) {
    body = <p className="muted small">Chưa đo. Bridge đo lại khoảng 30 giây một lần khi thẻ còn worktree; mở "Chi phí" của bảng để đo ngay.</p>;
  } else if (u.unsupported) {
    body = <p className="muted small">Agent này không ghi lại lượng token theo cách đọc được, nên chưa tính được chi phí.</p>;
  } else if (s.tokens === 0) {
    body = <p className="muted small">Chưa thấy lượt gọi model nào của agent cho thẻ này.</p>;
  } else {
    body = (
      <>
        <table className="usage-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Token</th>
              <th>Lượt</th>
              <th>Chi phí</th>
            </tr>
          </thead>
          <tbody>
            {s.models.map((m) => (
              <tr key={m.model}>
                <td>
                  <code>{m.model}</code>
                </td>
                <td>{formatTokens(m.tokens)}</td>
                <td>{m.requests}</td>
                <td>{m.usd === null ? <span className="muted">chưa có giá</span> : formatUsd(m.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {ctx ? (
          <p className={`small${ctx > CONTEXT_WARN ? ' warn-text' : ' muted'}`}>
            Context hiện tại: {formatTokens(ctx)} token (mỗi bước agent đọc lại chừng này).
            {ctx > CONTEXT_WARN && ' Đã lớn: phần việc còn lại nên giao ở thẻ mới, chọn thẻ này làm thẻ nền, để agent bắt đầu gọn.'}
          </p>
        ) : null}
        {card.overBudgetAt && (
          <p className="small warn-text">
            Đã vượt ngân sách{project?.budget.cardUsd ? ` ${formatUsd(project.budget.cardUsd)}/thẻ` : ''} của bảng lúc{' '}
            {new Date(card.overBudgetAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}.
          </p>
        )}
        <p className="muted small">
          Ước tính theo giá API của nhà cung cấp (đã tính phần đọc/ghi cache). Nếu agent chạy bằng gói thuê bao, đây là chi phí quy đổi, không phải số
          tiền bị trừ thêm.
        </p>
      </>
    );
  }
  const head = u && !u.unsupported && s.tokens > 0;
  return (
    <details className="usage">
      <summary>
        <CircleDollarSign aria-hidden /> Chi phí AI
        {head && (
          <span className="usage-total">
            {' '}
            · {s.unpriced.length && s.usd === 0 ? 'chưa có giá' : `≈ ${formatUsd(s.usd)}`} · {formatTokens(s.tokens)} token
            {card.overBudgetAt && <span className="warn-text"> · vượt ngân sách</span>}
            {ctx && ctx > CONTEXT_WARN ? <span className="warn-text"> · context {formatTokens(ctx)}</span> : null}
          </span>
        )}
      </summary>
      {body}
    </details>
  );
}
