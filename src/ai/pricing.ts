import type { AIUsage } from './model';

/**
 * Cost ESTIMATE per call, in micro-USD (§32, §44). Never a source of truth: set Gemini's published rate with
 * AI_PRICES='{"gemini-3.8-flash":{"in":150000,"out":600000,"cached":3000}}'
 * (micro-USD per 1M tokens). Unknown models are costed at UNPRICED_CEILING (fail safe).
 */
export interface Rate { in: number; out: number; cached: number }
/** Only the test fixture is priced here (free); Gemini's rate comes from AI_PRICES. */
export const PRICE_SNAPSHOT: Record<string, Rate> = { fixture: { in: 0, out: 0, cached: 0 } };
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

/** Image tokens assumed for a read whose usage never came back (above Gemini's per-image counts: fail safe). */
export const IMAGE_TOKENS_CEILING = 1120;
/**
 * Cost-guard estimate for a call whose usage the provider never reported (a timeout): what it COULD have cost —
 * the prompt at ~4 characters per token, the whole output cap and each image at IMAGE_TOKENS_CEILING — at the
 * model's rate (UNPRICED_CEILING without one). Counted only in the cost guards, never as the person's tokens.
 */
export function ceilingCostMicroUsd(model: string, c: { inputChars: number; maxOutputTokens: number; images: number }, rates: Record<string, Rate> = PRICE_SNAPSHOT): number {
  const r = rates[model] ?? UNPRICED_CEILING;
  const input = Math.ceil(Math.max(c.inputChars, 0) / 4) + Math.max(c.images, 0) * IMAGE_TOKENS_CEILING;
  return Math.min(Math.ceil((input * r.in + Math.max(c.maxOutputTokens, 0) * r.out) / 1_000_000), 2_147_483_647);
}
