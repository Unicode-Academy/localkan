import { AGENT_LABELS, AGENTS, type AgentId } from '@localkan/protocol';
import type { AgentModels } from './hooks.ts';

/** The model's name as its CLI lists it, else the id itself. */
export function modelLabel(agent: AgentId, model: string, models: AgentModels): string {
  return models[agent]?.find((m) => m.id === model)?.label ?? model;
}

/** "Claude Code · Opus", or just the agent when it runs its default model. */
export function agentText(card: { agent: AgentId; model: string | null }, models: AgentModels): string {
  return card.model ? `${AGENT_LABELS[card.agent]} · ${modelLabel(card.agent, card.model, models)}` : AGENT_LABELS[card.agent];
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

export function saveLastChoice(agent: AgentId, model: string | null) {
  try {
    localStorage.setItem(LAST_AGENT_KEY, agent);
    if (model) localStorage.setItem(lastModelKey(agent), model);
    else localStorage.removeItem(lastModelKey(agent));
  } catch {
    /* storage unavailable */
  }
}
