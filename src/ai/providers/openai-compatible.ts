import { AIProviderError, postJson, type AIProvider, type AIRequest, type AIResult } from '../provider';

/**
 * Chat Completions-compatible adapter (DeepSeek and other OpenAI-compatible APIs). Usage comes from the response:
 * prompt_tokens / completion_tokens, cache hits from `prompt_cache_hit_tokens` (DeepSeek) or
 * `prompt_tokens_details.cached_tokens`. Image tokens are part of prompt_tokens in this API family.
 */
export function openAICompatibleProvider(opts: { name: string; baseUrl: string; apiKey: string; visionModels: readonly string[]; headers?: Record<string, string>; fetchImpl?: typeof fetch }): AIProvider {
  return {
    name: opts.name,
    supportsVision: (model) => opts.visionModels.includes(model),
    async complete(req: AIRequest): Promise<AIResult> {
      if (req.images?.length && !opts.visionModels.includes(req.model)) throw new AIProviderError('unsupported', 'model has no vision');
      const started = Date.now();
      const messages = [
        { role: 'system', content: req.system },
        ...req.messages.map((m, i) => (i === req.messages.length - 1 && req.images?.length
          ? { role: m.role, content: [{ type: 'text', text: m.content }, ...req.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } }))] }
          : m)),
      ];
      const body: Record<string, unknown> = { model: req.model, messages, max_tokens: req.maxOutputTokens, temperature: req.temperature ?? 0, stream: false };
      if (req.json) body.response_format = { type: 'json_object' };
      const data = await postJson(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, { ...opts.headers, authorization: `Bearer ${opts.apiKey}` }, body, req.timeoutMs, opts.fetchImpl) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        model?: string;
      };
      const u = data.usage ?? {};
      const usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0, image: 0 };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new AIProviderError('invalid_output', 'empty completion', false, usage);
      return { text, usage, model: data.model ?? req.model, latencyMs: Date.now() - started };
    },
  };
}
