import { useMemo, useState } from 'react';

interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

export interface ToastApi {
  items: Toast[];
  error: (text: string) => void;
  info: (text: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export function useToasts(): ToastApi {
  const [items, setItems] = useState<Toast[]>([]);
  const actions = useMemo(() => {
    const push = (kind: Toast['kind'], text: string) => {
      const id = ++seq;
      setItems((prev) => [...prev.slice(-3), { id, kind, text }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 4000);
    };
    return {
      error: (text: string) => push('error', text),
      info: (text: string) => push('info', text),
      dismiss: (id: number) => setItems((prev) => prev.filter((t) => t.id !== id)),
    };
  }, []);
  // Keep the action functions stable so effects can depend on them.
  return useMemo(() => ({ items, ...actions }), [items, actions]);
}

export function Toasts({ state }: { state: ToastApi }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {state.items.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => state.dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}
