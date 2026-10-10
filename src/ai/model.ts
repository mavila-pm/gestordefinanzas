import type { Operation } from './types';

/**
 * The AI boundary: what a model call takes and returns. Gemini (src/ai/gemini.ts) is the only runtime model; the
 * canned test fixture (src/ai/test-fixture.ts) has the same shape so tests and E2E exercise the real path.
 * Product and domain code never import the vendor SDK.
 */
export interface AIImage { mime: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string }
export interface AIMessage { role: 'user' | 'assistant'; content: string }

export interface AIRequest {
  operation: Operation;
  model: string;
  system: string;
  messages: AIMessage[];
  images?: AIImage[];
  /** JSON Schema the answer must follow (structured output enforced by the API). The caller still validates it. */
  schema?: Record<string, unknown>;
  maxOutputTokens: number;
  reasoning: 'off' | 'low' | 'high';
  timeoutMs: number;
}

/** Usage exactly as the API reported it (never estimated from text length in production). */
export interface AIUsage { input: number; output: number; cached: number; image: number }
export interface AIResult { text: string; usage: AIUsage; model: string; latencyMs: number }

export type AIFailure = 'timeout' | 'http' | 'rate_limited' | 'invalid_output' | 'unsupported' | 'not_configured';
export class AIError extends Error {
  readonly kind: AIFailure;
  readonly retryable: boolean;
  readonly usage: AIUsage | null;
  /** HTTP status from the API, when there was one (diagnostics only; never the API's message). */
  readonly status: number | null;
  constructor(kind: AIFailure, message: string, retryable = false, usage: AIUsage | null = null, status: number | null = null) {
    super(message);
    this.kind = kind; this.retryable = retryable; this.usage = usage; this.status = status;
  }
}

/** A model to call: Gemini at runtime, the canned fixture in tests. `name` is recorded with each call's usage. */
export interface AIModel {
  readonly name: string;
  complete(req: AIRequest): Promise<AIResult>;
}

export const ZERO_USAGE: AIUsage = { input: 0, output: 0, cached: 0, image: 0 };
