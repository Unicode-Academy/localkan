/** What an agent spent on a card, and what that would cost at API list prices. */

/** Tokens of one model at one price tier, as the agent CLI recorded them. */
export interface UsageBucket {
  /** Model id as the CLI wrote it (`claude-opus-5-5`, `gpt-6-luna`, `grok-4.7`). */
  model: string;
  /** `long`: prompts above the provider's long-context threshold; `fast`: fast mode. */
  tier: 'standard' | 'long' | 'fast';
  requests: number;
  /** Input tokens not served from the cache. */
  input: number;
  cacheRead: number;
  /** Written to the short-lived cache (Claude 5 minutes, OpenAI 30 minutes). */
  cacheWrite: number;
  /** Written to the long-lived cache (Claude 1 hour, OpenAI 12 hours). */
  cacheWriteLong: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** Cost the CLI reported itself (Grok); otherwise priced from `PRICES`. */
  costUsd?: number;
}

export interface CardUsage {
  agent: string;
  buckets: UsageBucket[];
  /** Agent sessions found for the card. */
  sessions: number;
  /** The agent keeps no record of its usage that can be read (Antigravity). */
  unsupported: boolean;
}

/** USD per million tokens. */
export interface Rate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteLong: number;
  output: number;
}

export interface ModelPrice {
  rate: Rate;
  /** Rates for prompts above the long-context threshold, when they differ. */
  long?: Rate;
  /** Fast mode multiplies every rate by this. */
  fast?: number;
}

const r = (input: number, cacheRead: number, cacheWrite: number, cacheWriteLong: number, output: number): Rate => ({
  input,
  cacheRead,
  cacheWrite,
  cacheWriteLong,
  output,
});
/** Claude: cache writes cost 1.25x input (5 minutes) or 2x input (1 hour). */
const claude = (input: number, cacheRead: number, output: number): Rate => r(input, cacheRead, input * 1.25, input * 2, output);
/** OpenAI models without cache-write prices: writes billed as input. */
const openai = (input: number, cacheRead: number, output: number): Rate => r(input, cacheRead, input, input, output);

/**
 * API list prices (first-party, standard tier), checked 2026-11-16: Anthropic's model table
 * and developers.openai.com/api/docs/pricing. Subscriptions (Claude Max, ChatGPT…) are billed
 * differently, so these are what the work would cost through the API. Grok reports its own cost.
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-2': { rate: claude(8, 0.2, 40), fast: 2 },
  'claude-mythos-5-2': { rate: claude(8, 0.2, 40), fast: 2 },
  'claude-fable-5-1': { rate: claude(10, 1, 50) },
  'claude-mythos-5-1': { rate: claude(10, 1, 50) },
  'claude-fable-5': { rate: claude(10, 1, 50) },
  'claude-opus-5-5': { rate: claude(4, 0.2, 20), fast: 2 },
  'claude-opus-5': { rate: claude(5, 0.5, 25), fast: 2 },
  'claude-opus-4-8': { rate: claude(5, 0.5, 25), fast: 2 },
  'claude-opus-4-7': { rate: claude(5, 0.5, 25) },
  'claude-opus-4-6': { rate: claude(5, 0.5, 25) },
  'claude-sonnet-5-5': { rate: claude(2, 0.1, 10) },
  'claude-sonnet-5': { rate: claude(2, 0.2, 10) },
  'claude-sonnet-4-6': { rate: claude(3, 0.3, 15) },
  // Haiku 5.5: prompts above 100K tokens cost more.
  'claude-haiku-5-5': { rate: claude(0.1, 0.01, 0.5), long: claude(0.5, 0.05, 2.5) },
  'claude-haiku-4-5': { rate: claude(1, 0.1, 5) },
  // OpenAI: prompts above 272K tokens cost more.
  'gpt-6-astra': { rate: r(10, 1, 12.5, 25, 50), long: r(20, 2, 25, 50, 75) },
  'gpt-6.1-sol': { rate: r(2, 0.1, 2.5, 5, 10), long: r(4, 0.2, 5, 10, 15) },
  'gpt-6.1-terra': { rate: r(1, 0.05, 1.25, 2.5, 5), long: r(2, 0.1, 2.5, 5, 7.5) },
  'gpt-6-sol': { rate: r(2, 0.2, 2.5, 5, 10), long: r(4, 0.4, 5, 10, 15) },
  'gpt-6-luna': { rate: r(0.1, 0.01, 0.125, 0.25, 0.5), long: r(0.2, 0.02, 0.25, 0.5, 0.75) },
  'gpt-5.6-sol': { rate: r(4, 0.4, 5, 10, 20), long: r(8, 0.8, 10, 20, 30) },
  'gpt-5.6-terra': { rate: r(2, 0.2, 2.5, 5, 12), long: r(4, 0.4, 5, 10, 18) },
  'gpt-5.6-luna': { rate: r(0.2, 0.02, 0.25, 0.5, 1.2), long: r(0.4, 0.04, 0.5, 1, 1.8) },
  'gpt-5.5': { rate: openai(5, 0.5, 30), long: openai(10, 1, 45) },
  'gpt-5.4': { rate: openai(2.5, 0.25, 15), long: openai(5, 0.5, 22.5) },
  'gpt-5.4-mini': { rate: openai(0.75, 0.075, 4.5) },
  'gpt-5.2': { rate: openai(1.75, 0.175, 14) },
  'gpt-5.1': { rate: openai(1.25, 0.125, 10) },
  'gpt-5': { rate: openai(1.25, 0.125, 10) },
  'gpt-5-mini': { rate: openai(0.25, 0.025, 2) },
};

/**
 * The price of a model id: the longest known id it starts with, followed by a variant
 * (`-codex`, `[1m]`, `@date`, `-20260101`) but not another version (`claude-opus-5` does
 * not price `claude-opus-5-7`, `gpt-5` does not price `gpt-5.6-sol`).
 */
export function priceOf(model: string): ModelPrice | null {
  const m = model.toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(PRICES)) {
    const rest = m.slice(key.length);
    const variant = m.startsWith(key) && /^(?:[[@:]|-(?!\d{1,2}(?:\D|$)))/.test(rest);
    if ((m === key || variant) && (!best || key.length > best.length)) best = key;
  }
  return best ? PRICES[best] : null;
}

export function bucketTokens(b: UsageBucket): number {
  return b.input + b.cacheRead + b.cacheWrite + b.cacheWriteLong + b.output;
}

/** Dollars for one bucket, or null when its model has no known price. */
export function bucketCost(b: UsageBucket): number | null {
  if (typeof b.costUsd === 'number') return b.costUsd;
  const p = priceOf(b.model);
  if (!p) return null;
  const rate = (b.tier === 'long' && p.long) || p.rate;
  const mult = b.tier === 'fast' ? (p.fast ?? 1) : 1;
  return (
    (mult *
      (b.input * rate.input +
        b.cacheRead * rate.cacheRead +
        b.cacheWrite * rate.cacheWrite +
        b.cacheWriteLong * rate.cacheWriteLong +
        b.output * rate.output)) /
    1e6
  );
}

export interface UsageSummary {
  usd: number;
  tokens: number;
  requests: number;
  /** Models whose tokens could not be priced (left out of `usd`). */
  unpriced: string[];
  /** Per model, tiers merged; most expensive first. */
  models: { model: string; usd: number | null; tokens: number; requests: number }[];
}

/** Totals of one card's usage, or of many cards together. */
export function summarizeUsage(usages: (CardUsage | null | undefined)[]): UsageSummary {
  const byModel = new Map<string, { model: string; usd: number | null; tokens: number; requests: number }>();
  for (const u of usages) {
    for (const b of u?.buckets ?? []) {
      const cost = bucketCost(b);
      const e = byModel.get(b.model) ?? { model: b.model, usd: 0, tokens: 0, requests: 0 };
      e.usd = cost === null || e.usd === null ? null : e.usd + cost;
      e.tokens += bucketTokens(b);
      e.requests += b.requests;
      byModel.set(b.model, e);
    }
  }
  const models = [...byModel.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.tokens - a.tokens);
  return {
    usd: models.reduce((n, m) => n + (m.usd ?? 0), 0),
    tokens: models.reduce((n, m) => n + m.tokens, 0),
    requests: models.reduce((n, m) => n + m.requests, 0),
    unpriced: models.filter((m) => m.usd === null).map((m) => m.model),
    models,
  };
}

/** "$0.42", "$12.30", "<$0.01". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
}

/** "850", "12,3K", "1,25M" (Vietnamese decimal comma). */
export function formatTokens(n: number): string {
  const f = (x: number, d: number) => x.toFixed(d).replace(/\.?0+$/, '').replace('.', ',');
  if (n >= 1e6) return `${f(n / 1e6, 2)}M`;
  if (n >= 1e3) return `${f(n / 1e3, 1)}K`;
  return String(n);
}
