import { gemini } from './gemini';
import type { AIModel } from './model';
import { testFixture } from './test-fixture';
import type { Operation } from './types';

/**
 * Server-side AI configuration (§29). Gemini is the only model; nothing here reaches the browser.
 *   GEMINI_API_KEY (server only; never NEXT_PUBLIC_; without it Vels answers deterministically)
 *   GEMINI_MODEL (default GEMINI_DEFAULT_MODEL)   AI_TIMEOUT_MS   AI_REASONING=off|low|high
 *   AI_MAX_INPUT_CHARS   AI_MAX_OUTPUT_<OPERATION>   AI_PRICES (JSON, see pricing.ts)
 *   AI_FIXTURE=1 → canned test fixture instead of Gemini (E2E only; ignored on a production deployment)
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

export interface AIConfig {
  model: string;
  timeoutMs: number;
  reasoning: 'off' | 'low' | 'high';
  maxInputChars: number;
  maxOutput: Record<Operation, number>;
}

type Env = Record<string, string | undefined>;
const int = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : d; };
/** Model IDs are plain tokens ("gemini-3.8-flash"): anything else falls back to the default. */
const modelId = (v: string | undefined) => (v && /^[a-z0-9][a-z0-9.-]{2,60}$/i.test(v.trim()) ? v.trim() : GEMINI_DEFAULT_MODEL);
const fixtureOn = (env: Env) => env.AI_FIXTURE === '1' && env.VERCEL_ENV !== 'production';

export function aiConfig(env: Env = process.env): AIConfig {
  return {
    model: fixtureOn(env) ? 'fixture' : modelId(env.GEMINI_MODEL),
    timeoutMs: int(env.AI_TIMEOUT_MS, 15000, 1000, 60000),
    reasoning: env.AI_REASONING === 'low' || env.AI_REASONING === 'high' ? env.AI_REASONING : 'off',
    maxInputChars: int(env.AI_MAX_INPUT_CHARS, 6000, 500, 40000),
    // Caps per call. On Gemini 3.x thinking counts inside them, so they leave room for LOW thinking + a short answer;
    // the answer itself stays short through the prompts, and the SQL budgets cap the spend (§40-§45).
    maxOutput: {
      onboarding_extract: int(env.AI_MAX_OUTPUT_ONBOARDING_EXTRACT, 2048, 1024, 8192),
      assistant_answer: int(env.AI_MAX_OUTPUT_ASSISTANT_ANSWER, 1024, 1024, 8192),
      vision_extract: int(env.AI_MAX_OUTPUT_VISION_EXTRACT, 2048, 1024, 8192),
    },
  };
}

/** Gemini when its key is set on the server; null otherwise (never a crash). AI_FIXTURE=1 swaps in the test fixture. */
export function aiModel(env: Env = process.env): AIModel | null {
  if (fixtureOn(env)) return testFixture();
  return env.GEMINI_API_KEY ? gemini({ apiKey: env.GEMINI_API_KEY }) : null;
}

/** What the UI may know: whether model inference (conversation, camera) is available at all (no names, no keys). */
export const aiAvailable = (env: Env = process.env) => aiModel(env) !== null;
