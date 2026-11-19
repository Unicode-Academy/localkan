import { AGENT_LABELS, AGENTS, EFFORT_LABELS, EFFORTS, type AgentId, type Effort } from '@localkan/protocol';
import type { AgentModels } from './hooks.ts';

/** The model's name as its CLI lists it, else the id itself. */
export function modelLabel(agent: AgentId, model: string, models: AgentModels): string {
  return models[agent]?.find((m) => m.id === model)?.label ?? model;
}

/** "Claude Code · Opus · effort vừa"; the model and effort only when not the CLI's default. */
export function agentText(card: { agent: AgentId; model: string | null; effort?: Effort | null }, models: AgentModels): string {
  let out = AGENT_LABELS[card.agent];
  if (card.model) out += ` · ${modelLabel(card.agent, card.model, models)}`;
  if (card.effort) out += ` · effort ${EFFORT_LABELS[card.effort].toLowerCase()}`;
  return out;
}

// The last agent and model picked when assigning a task, so the next one starts from them.
const LAST_AGENT_KEY = 'localkan.lastAgent';
const lastModelKey = (agent: AgentId) => `localkan.lastModel.${agent}`;

export function readLastAgent(): AgentId {
  try {
    const a = localStorage.getItem(LAST_AGENT_KEY);
    return (AGENTS as readonly string[]).includes(a ?? '') ? (a as AgentId) : 'claude';
  } catch {
    return 'claude';
  }
}

/** The model last used with `agent`, if this machine still offers it. */
export function readLastModel(agent: AgentId, models: AgentModels): string | null {
  try {
    const m = localStorage.getItem(lastModelKey(agent));
    return m && models[agent]?.some((x) => x.id === m) ? m : null;
  } catch {
    return null;
  }
}

export function saveLastChoice(agent: AgentId, model: string | null, effort?: Effort | null) {
  try {
    localStorage.setItem(LAST_AGENT_KEY, agent);
    if (model) localStorage.setItem(lastModelKey(agent), model);
    else localStorage.removeItem(lastModelKey(agent));
    if (effort !== undefined) {
      if (effort) localStorage.setItem(LAST_EFFORT_KEY, effort);
      else localStorage.removeItem(LAST_EFFORT_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

const LAST_EFFORT_KEY = 'localkan.lastEffort';

/** The effort last picked when assigning a task. */
export function readLastEffort(): Effort | null {
  try {
    const e = localStorage.getItem(LAST_EFFORT_KEY);
    return (EFFORTS as readonly string[]).includes(e ?? '') ? (e as Effort) : null;
  } catch {
    return null;
  }
}
