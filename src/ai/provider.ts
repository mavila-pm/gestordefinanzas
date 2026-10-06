import type { Operation } from './types';

/**
 * Provider abstraction (adenda §26). Product and domain code never import a vendor SDK: they talk to AIProvider.
 * Adapters live in src/ai/providers/ and are chosen by server-side configuration (src/ai/config.ts).
 */
export interface AIImage { mime: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string }
export interface AIMessage { role: 'user' | 'assistant'; content: string }

export interface AIRequest {
  operation: Operation;
  model: string;
  system: string;
  messages: AIMessage[];
  images?: AIImage[];
  /** Ask the provider for a single JSON object (structured extraction). */
  json: boolean;
  maxOutputTokens: number;
  /** 0 (default) = most deterministic; callers clamp to [0, 1]. */
  temperature?: number;
  reasoning: 'off' | 'low' | 'high';
  timeoutMs: number;
}

/** Usage exactly as the provider reported it (never estimated from text length in production). */
export interface AIUsage { input: number; output: number; cached: number; image: number }
export interface AIResult { text: string; usage: AIUsage; model: string; latencyMs: number }

export type AIFailure = 'timeout' | 'http' | 'rate_limited' | 'invalid_output' | 'unsupported' | 'not_configured';
export class AIProviderError extends Error {
  readonly kind: AIFailure;
  readonly retryable: boolean;
  readonly usage: AIUsage | null;
  constructor(kind: AIFailure, message: string, retryable = false, usage: AIUsage | null = null) {
    super(message);
    this.kind = kind; this.retryable = retryable; this.usage = usage;
  }
}

export interface AIProvider {
  readonly name: string;
  supportsVision(model: string): boolean;
  complete(req: AIRequest): Promise<AIResult>;
}

export const ZERO_USAGE: AIUsage = { input: 0, output: 0, cached: 0, image: 0 };

/** fetch with a hard timeout; network errors and 5xx are retryable, 4xx are not. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (res.status === 429) throw new AIProviderError('rate_limited', 'provider rate limited', true);
    if (!res.ok) throw new AIProviderError('http', `provider http ${res.status}`, res.status >= 500);
    return await res.json();
  } catch (e) {
    if (e instanceof AIProviderError) throw e;
    if ((e as Error).name === 'AbortError') throw new AIProviderError('timeout', 'provider timeout', true);
    throw new AIProviderError('http', 'provider unreachable', true);
  } finally {
    clearTimeout(timer);
  }
}
