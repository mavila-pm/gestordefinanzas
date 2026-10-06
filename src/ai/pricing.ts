import type { AIUsage } from './provider';

/**
 * Cost ESTIMATE per call, in micro-USD (§32, §44). Prices are a dated SNAPSHOT (docs/ai/provider-evaluation.md),
 * never a source of truth: override with AI_PRICES='{"model":{"in":150000,"out":600000,"cached":3000}}'
 * (micro-USD per 1M tokens). Unknown models are costed with the most expensive known rate (fail safe).
 */
export interface Rate { in: number; out: number; cached: number }
export const PRICE_SNAPSHOT_DATE = '2026-09-28';
export const PRICE_SNAPSHOT: Record<string, Rate> = {
  // DeepSeek V4.1 Flash (secondary sources; peak hours double). Vision-exp billed at Flash rates.
  'deepseek-chat': { in: 300_000, out: 1_200_000, cached: 6_000 },
  'deepseek-v4-flash-vision-exp': { in: 300_000, out: 1_200_000, cached: 6_000 },
  // Gemini 3.5 Flash-Lite (secondary sources; image input at the text rate).
  'gemini-flash-lite-latest': { in: 300_000, out: 2_500_000, cached: 30_000 },
  // OpenRouter's free router: $0 per token. Other OpenRouter models need ':free' or an AI_PRICES entry (else refused).
  'openrouter/free': { in: 0, out: 0, cached: 0 },
  'fixture-text': { in: 0, out: 0, cached: 0 },
  'fixture-vision': { in: 0, out: 0, cached: 0 },
};

export function ratesFrom(env: Record<string, string | undefined> = process.env): Record<string, Rate> {
  try {
    const extra = env.AI_PRICES ? JSON.parse(env.AI_PRICES) as Record<string, Rate> : {};
    const ok = Object.entries(extra).filter(([, r]) => [r?.in, r?.out, r?.cached].every((n) => Number.isInteger(n) && n >= 0));
    return { ...PRICE_SNAPSHOT, ...Object.fromEntries(ok) };
  } catch { return PRICE_SNAPSHOT; }
}

const FREE: Rate = { in: 0, out: 0, cached: 0 };
/** OpenRouter's ':free' variants cost $0 per token. */
const isFreeVariant = (model: string) => /^[a-z0-9._-]+\/[a-z0-9._-]+:free$/i.test(model);
export const isPriced = (model: string, rates: Record<string, Rate> = PRICE_SNAPSHOT) => model in rates || isFreeVariant(model);

export function estimateCostMicroUsd(model: string, u: AIUsage, rates: Record<string, Rate> = PRICE_SNAPSHOT): number {
  const worst = Object.values(rates).reduce((a, r) => ({ in: Math.max(a.in, r.in), out: Math.max(a.out, r.out), cached: Math.max(a.cached, r.cached) }), { in: 0, out: 0, cached: 0 });
  const r = rates[model] ?? (isFreeVariant(model) ? FREE : worst);
  const fresh = Math.max(u.input - u.cached, 0) + u.image;
  return Math.ceil((fresh * r.in + u.cached * r.cached + u.output * r.out) / 1_000_000);
}
