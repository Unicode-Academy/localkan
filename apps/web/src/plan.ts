import { addedText, parsePlan, PLAN_FILE, type PlanRead } from '@localkan/protocol';

export type { PlanRead };

/** The plan a planning agent wrote, read from its diff. Null when there is no plan file yet. */
export function readPlan(patch: string): PlanRead | null {
  return parsePlan(addedText(patch, PLAN_FILE));
}
