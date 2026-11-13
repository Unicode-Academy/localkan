import { CARD_STATUS_LABELS, type Card } from '@localkan/protocol';

/** Choose an earlier card to continue from (cards that have run and have a branch). */
export function ParentSelect({
  cards,
  value,
  onChange,
  excludeId,
}: {
  cards: Card[];
  value: string | null;
  onChange: (id: string | null) => void;
  excludeId?: string;
}) {
  const options = cards
    .filter((c) => c.id !== excludeId && c.branch)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <label>
      Làm tiếp từ thẻ
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Không (bắt đầu từ nhánh gốc)</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title} · {CARD_STATUS_LABELS[c.status]}
          </option>
        ))}
      </select>
      <span className="muted small hint">
        Thẻ mới nhận đầy đủ ghi chú bàn giao của thẻ này. Nếu nhánh của nó chưa merge, worktree mới sẽ bắt đầu từ nhánh đó.
      </span>
    </label>
  );
}
