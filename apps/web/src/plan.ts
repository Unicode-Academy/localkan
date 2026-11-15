import { PLAN_FILE, type Plan, type PlanTask } from '@localkan/protocol';
import { addedText } from './text.ts';

export type PlanRead = { plan: Plan } | { error: string; raw: string } | null;

/** The plan a planning agent wrote, read from its diff. Null when there is no plan file yet. */
export function readPlan(patch: string): PlanRead {
  const raw = addedText(patch, PLAN_FILE);
  if (!raw?.trim()) return null;
  // Tolerate a Markdown fence around the JSON.
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { error: `Không đọc được ${PLAN_FILE}: ${(err as Error).message}`, raw };
  }
  const obj = (data ?? {}) as { goal?: unknown; tasks?: unknown };
  const tasks: PlanTask[] = (Array.isArray(obj.tasks) ? obj.tasks : [])
    .map((t) => ({ title: String((t as PlanTask)?.title ?? '').trim(), prompt: String((t as PlanTask)?.prompt ?? '').trim() }))
    .filter((t) => t.title);
  if (!tasks.length) return { error: `${PLAN_FILE} chưa có việc nào (mục "tasks").`, raw };
  return { plan: { goal: String(obj.goal ?? '').trim(), tasks } };
}
