import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { AIProviderError, type AIProvider, type AIRequest, type AIResult, type AIUsage } from '../provider';

/** The slice of the official SDK this adapter uses (injectable in tests: no network, no key). */
export interface GeminiModels {
  generateContent(params: Parameters<GoogleGenAI['models']['generateContent']>[0]): Promise<{
    text?: string;
    modelVersion?: string;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number;
      promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }> };
  }>;
}

const THINKING: Record<AIRequest['reasoning'], ThinkingLevel> = { off: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, high: ThinkingLevel.HIGH };

/**
 * Gemini adapter on the official SDK (@google/genai). Server only: the key comes from the caller (config.ts reads
 * GEMINI_API_KEY) and is never logged or returned. Structured output via responseJsonSchema when the request has a
 * schema. The SDK's own retries are off: lib/ai.ts decides retries (at most one, each reserved and recorded).
 * Usage from usageMetadata (thinking billed as output; image tokens split out of the prompt count).
 */
export function geminiProvider(opts: { apiKey?: string; models?: GeminiModels }): AIProvider {
  const models: GeminiModels = opts.models ?? new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { retryOptions: { attempts: 1 } } }).models;
  return {
    name: 'gemini',
    supportsVision: () => true,
    async complete(req: AIRequest): Promise<AIResult> {
      const started = Date.now();
      const contents = req.messages.map((m, i) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }, ...(i === req.messages.length - 1 ? (req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.base64 } })) : [])],
      }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
      let res: Awaited<ReturnType<GeminiModels['generateContent']>>;
      try {
        res = await models.generateContent({
          model: req.model,
          contents,
          config: {
            systemInstruction: req.system,
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature ?? 0,
            thinkingConfig: { thinkingLevel: THINKING[req.reasoning] },
            ...(req.json ? { responseMimeType: 'application/json' } : {}),
            ...(req.schema ? { responseJsonSchema: req.schema } : {}),
            abortSignal: ctrl.signal,
          },
        });
      } catch (e) {
        throw geminiError(e, ctrl.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
      const u = res.usageMetadata ?? {};
      const image = (u.promptTokensDetails ?? []).filter((d) => d.modality === 'IMAGE').reduce((s, d) => s + (d.tokenCount ?? 0), 0);
      const usage: AIUsage = { input: Math.max((u.promptTokenCount ?? 0) - image, 0), output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cached: u.cachedContentTokenCount ?? 0, image };
      const text = res.text ?? '';
      // Empty or blocked (safety, max tokens before any text): it cost tokens, it is not an answer.
      if (!text.trim()) throw new AIProviderError('invalid_output', 'empty completion', false, usage);
      return { text, usage, model: res.modelVersion ?? req.model, latencyMs: Date.now() - started };
    },
  };
}

/** SDK/network failure → provider-neutral kind. Never carries the provider's message (it may echo the request). */
export function geminiError(e: unknown, aborted: boolean): AIProviderError {
  if (aborted || (e as Error)?.name === 'AbortError') return new AIProviderError('timeout', 'provider timeout', true);
  const status = e instanceof ApiError ? e.status : typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  if (status === 429) return new AIProviderError('rate_limited', 'provider rate limited', true);
  if (status !== null) return new AIProviderError('http', `provider http ${status}`, status >= 500);
  return new AIProviderError('http', 'provider unreachable', true);
}
