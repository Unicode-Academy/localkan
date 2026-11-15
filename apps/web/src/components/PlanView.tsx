import { useMemo, useState } from 'react';
import { ArchiveRestore, ListPlus } from 'lucide-react';
import { AGENT_LABELS, AGENTS, parsePlan, PLAN_FILE, type AgentId, type Card, type DiffResult, type Project } from '@localkan/protocol';
import { api } from '../api.ts';
import { useAgentModels } from '../hooks.ts';
import { readLastAgent, readLastModel, saveLastChoice } from '../models.ts';
import { readPlan } from '../plan.ts';
import { Markdown } from './Markdown.tsx';
import { ModelSelect } from './ModelSelect.tsx';
import type { ToastApi } from './Toasts.tsx';

/** The plan a planning card produced: its tasks, which to keep, and "import into To Do".
 *  An open card's plan is read from its worktree (`diff`); a closed card's from the copy kept
 *  on the card when it closed. */
export function PlanView({ card, project, diff, toasts }: { card: Card; project: Project; diff: DiffResult | null; toasts: ToastApi }) {
  const closed = card.status === 'done';
  const read = useMemo(
    () => (closed ? parsePlan(card.planText) : diff ? readPlan(diff.patch) : null),
    [closed, card.planText, diff],
  );
  const models = useAgentModels(project.deviceId);
  const [agent, setAgent] = useState<AgentId>(readLastAgent);
  const [model, setModel] = useState<string | null>(() => readLastModel(agent, models));
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set());
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);

  if (!closed && !diff) return <p className="muted small">Đang tải kế hoạch…</p>;
  if (!read) {
    if (closed) return <RestorePlan card={card} toasts={toasts} />;
    const working = card.runState === 'running' || card.runState === 'starting' || card.status === 'needs_input';
    return (
      <p className="muted">
        {working ? 'Agent đang tìm hiểu và lập kế hoạch; nếu cần, nó sẽ hỏi bạn trước.' : `Agent chưa viết kế hoạch (${PLAN_FILE}). Dùng "Yêu cầu sửa" để nhắc nó.`}
      </p>
    );
  }
  if ('error' in read) {
    return (
      <div className="plan">
        <p className="error-text">{read.error}</p>
        <pre className="prompt">{read.raw}</pre>
      </div>
    );
  }

  const { plan } = read;
  const chosen = plan.tasks.filter((_, i) => !skipped.has(i));
  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  };
  const importNow = async () => {
    if (
      card.planImport &&
      !confirm(`Kế hoạch này đã nhập ${card.planImport.count} việc vào To Do. Nhập lần nữa sẽ tạo thêm thẻ. Tiếp tục?`)
    )
      return;
    setBusy(true);
    try {
      const r = await api.importPlan(card.id, chosen, agent, model);
      saveLastChoice(agent, model);
      toasts.info(`Đã nhập ${r.created} việc vào To Do.`);
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan">
      {closed && <p className="muted small">Thẻ đã đóng. Đây là bản kế hoạch lưu lại lúc đóng, vẫn nhập vào To Do được.</p>}
      {plan.goal && <Markdown text={plan.goal} className="plan-goal" />}
      <ol className="plan-tasks">
        {plan.tasks.map((t, i) => (
          <li key={i} className={skipped.has(i) ? 'off' : undefined}>
            <label className="plan-task-head">
              <input type="checkbox" checked={!skipped.has(i)} onChange={() => setSkipped((s) => toggle(s, i))} />
              <span>
                <span className="plan-no">{i + 1}.</span> <strong>{t.title}</strong>
              </span>
            </label>
            {t.prompt && (
              <div
                role="button"
                tabIndex={0}
                className={`plan-prompt${open.has(i) ? ' open' : ''}`}
                onClick={() => setOpen((s) => toggle(s, i))}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen((s) => toggle(s, i)))}
                title={open.has(i) ? 'Thu gọn' : 'Xem đầy đủ'}
              >
                <Markdown text={t.prompt} />
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="plan-import">
        <div className="row">
          <select
            value={agent}
            onChange={(e) => {
              const a = e.target.value as AgentId;
              setAgent(a);
              setModel(readLastModel(a, models));
            }}
            aria-label="Agent cho các việc"
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABELS[a]}
              </option>
            ))}
          </select>
          <ModelSelect agent={agent} models={models} value={model} onChange={setModel} />
        </div>
        <button className="btn primary" disabled={busy || chosen.length === 0} onClick={importNow}>
          <ListPlus /> {busy ? 'Đang nhập…' : `Nhập ${chosen.length} việc vào To Do`}
        </button>
        {card.planImport && (
          <p className="muted small">
            Đã nhập {card.planImport.count} việc vào To Do lúc{' '}
            {new Date(card.planImport.at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}.
          </p>
        )}
      </div>
    </div>
  );
}

/** A closed planning card with no plan kept (closed before plans were kept on cards, or the
 *  agent never wrote one): paste the plan file back to read and import it. */
function RestorePlan({ card, toasts }: { card: Card; toasts: ToastApi }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.restorePlan(card.id, text);
      toasts.info('Đã khôi phục kế hoạch.');
    } catch (err) {
      toasts.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plan">
      <p className="muted">
        Thẻ đã đóng và không còn bản kế hoạch: thẻ đóng trước khi Localkan lưu kế hoạch vào thẻ, hoặc agent chưa viết kế hoạch. Nếu bạn
        còn nội dung <code>{PLAN_FILE}</code>, dán vào đây để xem và nhập vào To Do.
      </p>
      <textarea
        className="plan-paste"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"goal": "…", "tasks": [{"title": "…", "prompt": "…"}]}'
        aria-label={`Nội dung ${PLAN_FILE}`}
        spellCheck={false}
      />
      <button className="btn primary" disabled={busy || !text.trim()} onClick={save}>
        <ArchiveRestore /> {busy ? 'Đang khôi phục…' : 'Khôi phục kế hoạch'}
      </button>
    </div>
  );
}
