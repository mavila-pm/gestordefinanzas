import { AIProviderError, postJson, type AIProvider, type AIRequest, type AIResult } from '../provider';

/**
 * Gemini Developer API adapter (generateContent). Usage from usageMetadata: promptTokenCount (image tokens are
 * broken down in promptTokensDetails[modality=IMAGE]), candidatesTokenCount + thoughtsTokenCount (thinking is
 * billed as output), cachedContentTokenCount. Thinking is disabled unless the request asks for reasoning.
 */
export function geminiProvider(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): AIProvider {
  const base = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  return {
    name: 'gemini',
    supportsVision: () => true,
    async complete(req: AIRequest): Promise<AIResult> {
      const started = Date.now();
      const contents = req.messages.map((m, i) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }, ...(i === req.messages.length - 1 ? (req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.base64 } })) : [])],
      }));
      const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens, temperature: 0 };
      if (req.json) generationConfig.responseMimeType = 'application/json';
      generationConfig.thinkingConfig = { thinkingBudget: req.reasoning === 'off' ? 0 : req.reasoning === 'low' ? 512 : 2048 };
      const data = await postJson(`${base}/models/${encodeURIComponent(req.model)}:generateContent`, { 'x-goog-api-key': opts.apiKey },
        { systemInstruction: { parts: [{ text: req.system }] }, contents, generationConfig }, req.timeoutMs, opts.fetchImpl) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number;
          promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }> };
        modelVersion?: string;
      };
      const u = data.usageMetadata ?? {};
      const image = (u.promptTokensDetails ?? []).filter((d) => d.modality === 'IMAGE').reduce((s, d) => s + (d.tokenCount ?? 0), 0);
      const usage = { input: Math.max((u.promptTokenCount ?? 0) - image, 0), output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cached: u.cachedContentTokenCount ?? 0, image };
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text.trim()) throw new AIProviderError('invalid_output', 'empty completion', false, usage);
      return { text, usage, model: data.modelVersion ?? req.model, latencyMs: Date.now() - started };
    },
  };
}
