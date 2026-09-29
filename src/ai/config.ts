import type { AIProvider } from './provider';
import type { Operation } from './types';
import { geminiProvider } from './providers/gemini';
import { openAICompatibleProvider } from './providers/openai-compatible';
import { fixtureProvider } from './providers/fixture';

/**
 * Server-side AI configuration (§29). Nothing here reaches the browser: keys are read only on the server, and the
 * default is `none` (the product works fully without AI; deterministic interpretation still runs).
 *   AI_PROVIDER=none|deepseek|gemini|fixture   AI_TEXT_MODEL  AI_VISION_MODEL
 *   AI_FALLBACK_PROVIDER / AI_FALLBACK_MODEL    AI_TIMEOUT_MS  AI_REASONING=off|low|high  AI_MAX_INPUT_CHARS
 *   AI_MAX_OUTPUT_<OPERATION>                    DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL   GEMINI_API_KEY
 *   AI_PRICES (JSON snapshot override, see pricing.ts)   AI_ALLOW_FIXTURE=1 (tests/demo only, never production)
 */
export type ProviderName = 'none' | 'deepseek' | 'gemini' | 'fixture';
export interface AIConfig {
  provider: ProviderName;
  textModel: string;
  visionModel: string;
  fallbackProvider: ProviderName;
  fallbackModel: string;
  timeoutMs: number;
  reasoning: 'off' | 'low' | 'high';
  maxInputChars: number;
  maxOutput: Record<Operation, number>;
}

const DEFAULT_MODELS: Record<Exclude<ProviderName, 'none'>, { text: string; vision: string }> = {
  deepseek: { text: 'deepseek-chat', vision: 'deepseek-v4-flash-vision-exp' },
  gemini: { text: 'gemini-flash-lite-latest', vision: 'gemini-flash-lite-latest' },
  fixture: { text: 'fixture-text', vision: 'fixture-vision' },
};

type Env = Record<string, string | undefined>;
const name = (v: string | undefined): ProviderName => (v === 'deepseek' || v === 'gemini' || v === 'fixture' ? v : 'none');
const int = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : d; };

/** Fixtures answer with canned data: allowed only when explicitly enabled and never on a production deployment. */
export const fixtureAllowed = (env: Env) => env.AI_ALLOW_FIXTURE === '1' && env.VERCEL_ENV !== 'production';

export function aiConfig(env: Env = process.env): AIConfig {
  let provider = name(env.AI_PROVIDER);
  if (provider === 'fixture' && !fixtureAllowed(env)) provider = 'none';
  const models = provider === 'none' ? { text: '', vision: '' } : DEFAULT_MODELS[provider];
  const fallbackProvider = name(env.AI_FALLBACK_PROVIDER);
  return {
    provider,
    textModel: env.AI_TEXT_MODEL || models.text,
    visionModel: env.AI_VISION_MODEL || models.vision,
    fallbackProvider: fallbackProvider === 'fixture' && !fixtureAllowed(env) ? 'none' : fallbackProvider,
    fallbackModel: env.AI_FALLBACK_MODEL || (fallbackProvider === 'none' ? '' : DEFAULT_MODELS[fallbackProvider].text),
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

/** Builds the adapter for a provider name, or null when it is not configured (no key → no provider, never a crash). */
export function providerFor(p: ProviderName, env: Env = process.env): AIProvider | null {
  switch (p) {
    case 'deepseek':
      return env.DEEPSEEK_API_KEY ? openAICompatibleProvider({ name: 'deepseek', baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY, visionModels: [DEFAULT_MODELS.deepseek.vision, ...(env.AI_VISION_MODEL ? [env.AI_VISION_MODEL] : [])] }) : null;
    case 'gemini':
      return env.GEMINI_API_KEY ? geminiProvider({ apiKey: env.GEMINI_API_KEY }) : null;
    case 'fixture':
      return fixtureAllowed(env) ? fixtureProvider() : null;
    default:
      return null;
  }
}

/** What the UI may know: whether conversation/camera inference is available at all (no names, no keys). */
export function aiAvailability(env: Env = process.env): { text: boolean; vision: boolean } {
  const cfg = aiConfig(env);
  const p = providerFor(cfg.provider, env);
  return { text: !!p, vision: !!p && p.supportsVision(cfg.visionModel) };
}
