import type { AIProvider } from './provider';
import type { Operation } from './types';
import { geminiProvider } from './providers/gemini';
import { fixtureProvider } from './providers/fixture';

/**
 * Server-side AI configuration (§29). Gemini is the only provider (MVP decision); nothing here reaches the browser.
 *   GEMINI_API_KEY (server only; never NEXT_PUBLIC_)   GEMINI_MODEL (default GEMINI_DEFAULT_MODEL)
 *   AI_PROVIDER=none disables inference (the product works fully without it; deterministic answers still run)
 *   AI_TIMEOUT_MS  AI_REASONING=off|low|high  AI_MAX_INPUT_CHARS  AI_MAX_OUTPUT_<OPERATION>
 *   AI_PRICES (JSON override, see pricing.ts)   AI_PROVIDER=fixture + AI_ALLOW_FIXTURE=1 (tests/demo only, never production)
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export type ProviderName = 'none' | 'gemini' | 'fixture';
export interface AIConfig {
  provider: ProviderName;
  textModel: string;
  visionModel: string;
  timeoutMs: number;
  reasoning: 'off' | 'low' | 'high';
  maxInputChars: number;
  maxOutput: Record<Operation, number>;
}

type Env = Record<string, string | undefined>;
const int = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : d; };
/** Model IDs are plain tokens ("gemini-3.8-flash"): anything else falls back to the default. */
const modelId = (v: string | undefined) => (v && /^[a-z0-9][a-z0-9.-]{2,60}$/i.test(v.trim()) ? v.trim() : GEMINI_DEFAULT_MODEL);

/** Fixtures answer with canned data: allowed only when explicitly enabled and never on a production deployment. */
export const fixtureAllowed = (env: Env) => env.AI_ALLOW_FIXTURE === '1' && env.VERCEL_ENV !== 'production';

export function aiConfig(env: Env = process.env): AIConfig {
  const asked = env.AI_PROVIDER?.trim();
  const provider: ProviderName = asked === 'none' ? 'none' : asked === 'fixture' ? (fixtureAllowed(env) ? 'fixture' : 'none') : 'gemini';
  const model = provider === 'fixture' ? { text: 'fixture-text', vision: 'fixture-vision' } : provider === 'gemini' ? { text: modelId(env.GEMINI_MODEL), vision: modelId(env.GEMINI_MODEL) } : { text: '', vision: '' };
  return {
    provider,
    textModel: model.text,
    visionModel: model.vision,
    timeoutMs: int(env.AI_TIMEOUT_MS, 15000, 1000, 60000),
    reasoning: env.AI_REASONING === 'low' || env.AI_REASONING === 'high' ? env.AI_REASONING : 'off',
    maxInputChars: int(env.AI_MAX_INPUT_CHARS, 6000, 500, 40000),
    // Short answers are the UX and the cost control at once (§40-§41).
    maxOutput: {
      onboarding_extract: int(env.AI_MAX_OUTPUT_ONBOARDING_EXTRACT, 500, 50, 4000),
      assistant_answer: int(env.AI_MAX_OUTPUT_ASSISTANT_ANSWER, 300, 50, 4000),
      vision_extract: int(env.AI_MAX_OUTPUT_VISION_EXTRACT, 400, 50, 4000),
    },
  };
}

/** Builds the adapter, or null when it is not configured (no key → no provider, never a crash). */
export function providerFor(p: ProviderName, env: Env = process.env): AIProvider | null {
  if (p === 'gemini') return env.GEMINI_API_KEY ? geminiProvider({ apiKey: env.GEMINI_API_KEY }) : null;
  if (p === 'fixture') return fixtureAllowed(env) ? fixtureProvider() : null;
  return null;
}

/** What the UI may know: whether conversation/camera inference is available at all (no names, no keys). */
export function aiAvailability(env: Env = process.env): { text: boolean; vision: boolean } {
  const cfg = aiConfig(env);
  const p = providerFor(cfg.provider, env);
  return { text: !!p, vision: !!p && p.supportsVision(cfg.visionModel) };
}
