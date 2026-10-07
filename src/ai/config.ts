import type { AIProvider } from './provider';
import type { Operation } from './types';
import { geminiProvider } from './providers/gemini';
import { openAICompatibleProvider } from './providers/openai-compatible';
import { fixtureProvider } from './providers/fixture';
import { isPriced, ratesFrom } from './pricing';

/**
 * Server-side AI configuration (§29). Nothing here reaches the browser: keys are read only on the server, and the
 * default is `none` (the product works fully without AI; deterministic interpretation still runs).
 *   AI_PROVIDER=none|deepseek|gemini|fixture   AI_TEXT_MODEL  AI_VISION_MODEL
 *   AI_FALLBACK_PROVIDER / AI_FALLBACK_MODEL    AI_TIMEOUT_MS  AI_REASONING=off|low|high  AI_MAX_INPUT_CHARS
 *   AI_MAX_OUTPUT_<OPERATION>                    DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL   GEMINI_API_KEY
 *   OPENROUTER_API_KEY / OPENROUTER_MODEL (default openrouter/free) / APP_URL (attribution referer)
 *   AI_PRICES (JSON snapshot override, see pricing.ts)   AI_ALLOW_FIXTURE=1 (tests/demo only, never production)
 * OPENROUTER_API_KEY alone powers only generic, account-free calls (generalAIConfig → generateAIResponse). Vels and
 * onboarding send account state, so they use OpenRouter only with an explicit AI_PROVIDER=openrouter (a privacy decision:
 * free routes may log prompts). OpenRouter models must be priced (free or AI_PRICES), or the provider stays off.
 */
export type ProviderName = 'none' | 'deepseek' | 'gemini' | 'openrouter' | 'fixture';
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
  openrouter: { text: 'openrouter/free', vision: '' },
  fixture: { text: 'fixture-text', vision: 'fixture-vision' },
};

type Env = Record<string, string | undefined>;
const name = (v: string | undefined): ProviderName => (v === 'deepseek' || v === 'gemini' || v === 'openrouter' || v === 'fixture' ? v : 'none');
/** The model a provider uses by default; OpenRouter's is swappable without code (OPENROUTER_MODEL). */
const textDefault = (p: Exclude<ProviderName, 'none'>, env: Env) => (p === 'openrouter' && env.OPENROUTER_MODEL?.trim()) || DEFAULT_MODELS[p].text;
/** Public URL sent to OpenRouter as the app's attribution (never request input). */
export function appUrl(env: Env): string {
  const explicit = env.APP_URL || env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_BRANCH_URL || env.VERCEL_URL;
  return host ? `https://${host}` : 'http://localhost:3000';
}
const int = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : d; };

/** Fixtures answer with canned data: allowed only when explicitly enabled and never on a production deployment. */
export const fixtureAllowed = (env: Env) => env.AI_ALLOW_FIXTURE === '1' && env.VERCEL_ENV !== 'production';

export function aiConfig(env: Env = process.env): AIConfig {
  let provider = name(env.AI_PROVIDER);
  if (provider === 'fixture' && !fixtureAllowed(env)) provider = 'none';
  const models = provider === 'none' ? { text: '', vision: '' } : { text: textDefault(provider, env), vision: DEFAULT_MODELS[provider].vision };
  const fallbackProvider = name(env.AI_FALLBACK_PROVIDER);
  return {
    provider,
    textModel: env.AI_TEXT_MODEL || models.text,
    visionModel: env.AI_VISION_MODEL || models.vision,
    fallbackProvider: fallbackProvider === 'fixture' && !fixtureAllowed(env) ? 'none' : fallbackProvider,
    fallbackModel: env.AI_FALLBACK_MODEL || (fallbackProvider === 'none' ? '' : textDefault(fallbackProvider, env)),
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

/** Config for generic calls without account data: AI_PROVIDER if set, else OpenRouter when its key exists. */
export function generalAIConfig(env: Env = process.env): AIConfig {
  return aiConfig(env.AI_PROVIDER || !env.OPENROUTER_API_KEY ? env : { ...env, AI_PROVIDER: 'openrouter' });
}

/** Builds the adapter for a provider name, or null when it is not configured (no key → no provider, never a crash). */
export function providerFor(p: ProviderName, env: Env = process.env): AIProvider | null {
  switch (p) {
    case 'deepseek':
      return env.DEEPSEEK_API_KEY ? openAICompatibleProvider({ name: 'deepseek', baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY, visionModels: [DEFAULT_MODELS.deepseek.vision, ...(env.AI_VISION_MODEL ? [env.AI_VISION_MODEL] : [])] }) : null;
    case 'openrouter':
      // Text only for now: no vision model is declared, so camera reads keep their own provider or stay off.
      // An unpriced model would be under-costed and slip past the budget guards: refuse it (fail closed).
      return env.OPENROUTER_API_KEY && isPriced(textDefault('openrouter', env), ratesFrom(env)) ? openAICompatibleProvider({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY, visionModels: [],
        headers: { 'HTTP-Referer': appUrl(env), 'X-Title': 'Velsuno' } }) : null;
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
