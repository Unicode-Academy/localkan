import { useMemo } from 'react';
import { CircleDollarSign } from 'lucide-react';
import { formatTokens, formatUsd, summarizeUsage, type Card } from '@localkan/protocol';

/** A card's cost on its board tile: "$0.84". Nothing until measured. */
export function CostTag({ card }: { card: Card }) {
  const s = useMemo(() => summarizeUsage([card.usage]), [card.usage]);
  if (!card.usage || card.usage.unsupported || s.tokens === 0) return null;
  const partial = s.unpriced.length > 0;
  return (
    <span
      className="tag cost-tag"
      title={`Chi phí AI ước tính theo giá API: ${formatUsd(s.usd)}${partial ? ' (chưa gồm model chưa có giá)' : ''} · ${formatTokens(s.tokens)} token`}
    >
      {partial && s.usd === 0 ? `${formatTokens(s.tokens)} tk` : formatUsd(s.usd)}
    </span>
  );
}

/** What the card's agent spent: total, then per model. */
export function UsageSection({ card }: { card: Card }) {
  const s = useMemo(() => summarizeUsage([card.usage]), [card.usage]);
  if (card.status === 'todo') return null;
  const u = card.usage;
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
          </span>
        )}
      </summary>
      {body}
    </details>
  );
}
