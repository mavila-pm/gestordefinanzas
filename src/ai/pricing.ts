import type { AIUsage } from './provider';

/**
 * Cost ESTIMATE per call, in micro-USD (§32, §44). Prices are a dated SNAPSHOT (docs/ai/provider-evaluation.md),
 * never a source of truth: override with AI_PRICES='{"model":{"in":150000,"out":600000,"cached":3000}}'
 * (micro-USD per 1M tokens). Unknown models are costed at UNPRICED_CEILING (fail safe).
 */
export interface Rate { in: number; out: number; cached: number }
export const PRICE_SNAPSHOT_DATE = '2026-10-08';
export const PRICE_SNAPSHOT: Record<string, Rate> = {
  'fixture-text': { in: 0, out: 0, cached: 0 },
  'fixture-vision': { in: 0, out: 0, cached: 0 },
};
/**
 * Cost-guard CEILING for a model without a price entry (the Gemini model included until AI_PRICES carries its
 * published rate). Deliberately above current Flash-class list prices so budgets trip early, never late. Not a price.
 */
export const UNPRICED_CEILING: Rate = { in: 2_000_000, out: 12_000_000, cached: 200_000 };

export function ratesFrom(env: Record<string, string | undefined> = process.env): Record<string, Rate> {
  try {
    const extra = env.AI_PRICES ? JSON.parse(env.AI_PRICES) as Record<string, Rate> : {};
    const ok = Object.entries(extra).filter(([, r]) => [r?.in, r?.out, r?.cached].every((n) => Number.isInteger(n) && n >= 0));
    return { ...PRICE_SNAPSHOT, ...Object.fromEntries(ok) };
  } catch { return PRICE_SNAPSHOT; }
}

export function estimateCostMicroUsd(model: string, u: AIUsage, rates: Record<string, Rate> = PRICE_SNAPSHOT): number {
  const r = rates[model] ?? UNPRICED_CEILING;
  const fresh = Math.max(u.input - u.cached, 0) + u.image;
  return Math.ceil((fresh * r.in + u.cached * r.cached + u.output * r.out) / 1_000_000);
}
