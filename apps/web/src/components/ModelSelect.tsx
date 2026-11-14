import type { AgentId } from '@localkan/protocol';
import type { AgentModels } from '../hooks.ts';

/** Model for the agent CLI. Empty value: the CLI's own default. */
export function ModelSelect({
  agent,
  models,
  value,
  onChange,
  className,
}: {
  agent: AgentId;
  models: AgentModels;
  value: string | null;
  onChange: (model: string | null) => void;
  className?: string;
}) {
  const list = models[agent] ?? [];
  const fallback = list.find((m) => m.default);
  // A model the machine no longer lists (saved on the card earlier) stays selectable.
  const options = value && !list.some((m) => m.id === value) ? [...list, { id: value, label: value }] : list;
  return (
    <select
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={!options.length}
      aria-label="Model"
      title={options.length ? 'Model của agent' : 'Máy chưa báo danh sách model của agent này: dùng model mặc định'}
    >
      <option value="">{fallback ? `Model mặc định (${fallback.label})` : 'Model mặc định'}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
