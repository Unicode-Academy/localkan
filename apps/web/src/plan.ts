import { addedText, parsePlan, PLAN_FILE, type AgentId, type Effort, type PlanRead, type TaskLevel } from '@localkan/protocol';
import type { AgentModels } from './hooks.ts';

export type { PlanRead };

/** The plan a planning agent wrote, read from its diff. Null when there is no plan file yet. */
export function readPlan(patch: string): PlanRead | null {
  return parsePlan(addedText(patch, PLAN_FILE));
}

export const LEVEL_LABELS: Record<TaskLevel, string> = { simple: 'Đơn giản', normal: 'Vừa', hard: 'Khó' };

/**
 * Model and effort for a task of `level`. Claude: Sonnet (half Opus's price) for simple and
 * normal tasks, Opus for hard ones. Every agent: effort low / medium / high. A model this
 * machine does not offer leaves `fallback`.
 */
export function pickForLevel(
  agent: AgentId,
  level: TaskLevel,
  models: AgentModels,
  fallback: string | null,
): { model: string | null; effort: Effort } {
  const effort: Effort = level === 'simple' ? 'low' : level === 'hard' ? 'high' : 'medium';
  if (agent !== 'claude') return { model: fallback, effort };
  const want = level === 'hard' ? 'opus' : 'sonnet';
  return { model: models.claude?.some((m) => m.id === want) ? want : fallback, effort };
}
