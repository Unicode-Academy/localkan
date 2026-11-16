import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { AGENT_LABELS, CARD_STATUS_LABELS, formatTokens, formatUsd, summarizeUsage, type AgentId, type Card, type Device, type Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ToastApi } from './Toasts.tsx';

/** What the agents spent on a board: the total, per model, per agent and per card. Opening
 *  it measures every started card again (finished ones too). */
export function CostDialog({
  project,
  device,
  cards,
  onOpenCard,
  onClose,
  toasts,
}: {
  project: Project;
  device: Device | null;
  cards: Card[];
  onOpenCard: (id: string) => void;
  onClose: () => void;
  toasts: ToastApi;
}) {
  const [busy, setBusy] = useState(false);
  const online = !!device?.online;

  const refresh = async (quiet: boolean) => {
    setBusy(true);
    try {
      const r = await api.refreshUsage(project.id);
      if (!quiet) toasts.info(r.measured ? `Đã cập nhật ${r.measured} thẻ.` : 'Số liệu đã mới nhất.');
    } catch (err) {
      if (!quiet) toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (online) void refresh(true);
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const started = useMemo(() => cards.filter((c) => c.status !== 'todo'), [cards]);
  const total = useMemo(() => summarizeUsage(started.map((c) => c.usage)), [started]);
  const rows = useMemo(
    () =>
      started
        .map((c) => ({ card: c, s: summarizeUsage([c.usage]) }))
        .sort((a, b) => b.s.usd - a.s.usd || b.s.tokens - a.s.tokens),
    [started],
  );
  const byAgent = useMemo(() => {
    const m = new Map<string, { cards: number; usd: number; tokens: number }>();
    for (const { card, s } of rows) {
      if (!card.usage || card.usage.unsupported || s.tokens === 0) continue;
      const e = m.get(card.agent) ?? { cards: 0, usd: 0, tokens: 0 };
      e.cards++;
      e.usd += s.usd;
      e.tokens += s.tokens;
      m.set(card.agent, e);
    }
    return [...m.entries()].sort((a, b) => b[1].usd - a[1].usd);
  }, [rows]);
  const unmeasured = started.filter((c) => !c.usage).length;
  const unsupported = started.filter((c) => c.usage?.unsupported).length;

  return (
    <Dialog title={`Chi phí AI · ${project.name}`} onClose={onClose} wide>
      <div className="cost">
        <div className="cost-total">
          <div>
            <strong>≈ {formatUsd(total.usd)}</strong>
            <span className="muted small">
              {' '}
              {formatTokens(total.tokens)} token · {total.requests} lượt gọi · {started.length - unmeasured - unsupported}/{started.length} thẻ đã đo
            </span>
          </div>
          <button className="btn ghost small" onClick={() => refresh(false)} disabled={busy || !online} title={online ? 'Đo lại tất cả thẻ' : 'Máy chạy bridge đang offline'}>
            <RefreshCw className={busy ? 'spin' : undefined} /> {busy ? 'Đang đo…' : 'Đo lại'}
          </button>
        </div>
        <p className="muted small">
          Ước tính theo giá API của nhà cung cấp, gồm cả phần đọc/ghi cache; Grok tự báo chi phí của nó. Agent chạy bằng gói thuê bao thì đây là chi phí
          quy đổi, không phải tiền bị trừ thêm.
          {unsupported > 0 && ` ${unsupported} thẻ dùng agent không ghi lại token (Antigravity) nên chưa tính được.`}
          {total.unpriced.length > 0 && ` Chưa có giá cho: ${total.unpriced.join(', ')}.`}
          {!online && ' Máy chạy bridge đang offline: số liệu là lần đo gần nhất.'}
        </p>

        {total.models.length > 0 && (
          <section>
            <h3>Theo model</h3>
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
                {total.models.map((m) => (
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
          </section>
        )}

        {byAgent.length > 1 && (
          <section>
            <h3>Theo agent</h3>
            <table className="usage-table">
              <tbody>
                {byAgent.map(([agent, e]) => (
                  <tr key={agent}>
                    <td>{AGENT_LABELS[agent as AgentId] ?? agent}</td>
                    <td>{e.cards} thẻ</td>
                    <td>{formatTokens(e.tokens)}</td>
                    <td>{formatUsd(e.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h3>Theo thẻ</h3>
          {rows.length === 0 && <p className="muted small">Chưa có thẻ nào được giao cho agent.</p>}
          <ul className="cost-cards">
            {rows.map(({ card, s }) => (
              <li key={card.id}>
                <button className="cost-card" onClick={() => onOpenCard(card.id)}>
                  <span className="cost-card-title">{card.title}</span>
                  <span className="muted small">
                    {CARD_STATUS_LABELS[card.status]} · {AGENT_LABELS[card.agent]}
                    {s.tokens > 0 && ` · ${formatTokens(s.tokens)} token`}
                  </span>
                  <span className="cost-card-usd">
                    {!card.usage ? (
                      <span className="muted">chưa đo</span>
                    ) : card.usage.unsupported ? (
                      <span className="muted">không đo được</span>
                    ) : s.tokens === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      formatUsd(s.usd)
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
