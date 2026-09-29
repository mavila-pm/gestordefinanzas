import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { aiConfig, providerFor, type AIConfig } from '../src/ai/config';
import { AIProviderError, ZERO_USAGE, type AIImage, type AIMessage, type AIProvider, type AIUsage } from '../src/ai/provider';
import { estimateCostMicroUsd, ratesFrom } from '../src/ai/pricing';
import type { Operation } from '../src/ai/types';

/**
 * The only door to a provider (ADR-0006). Every call is: reserve (quota, rate limit, cost guards, under the
 * user's session) → provider → settle with the usage the provider reported. At most one retry, and only for
 * transient failures; a fallback provider is used only on failure/unsupported modality, never in parallel (§62).
 * Nothing here logs prompts or images.
 */
export type AIStop = 'ai_quota' | 'camera_quota' | 'ai_rate' | 'ai_budget' | 'too_many_images' | 'unavailable' | 'failed';
export type InferResult = { ok: true; text: string; usage: AIUsage; provider: string; model: string } | { ok: false; reason: AIStop };

const RESERVE_ERRORS: readonly AIStop[] = ['ai_quota', 'camera_quota', 'ai_rate', 'ai_budget', 'too_many_images'];
const OUTCOME: Record<string, 'error' | 'timeout' | 'invalid_output'> = { timeout: 'timeout', invalid_output: 'invalid_output' };

export async function infer(
  supabase: SupabaseClient,
  req: { operation: Operation; system: string; messages: AIMessage[]; images?: AIImage[]; json: boolean },
  validate: (text: string) => boolean = () => true,
  cfg: AIConfig = aiConfig(),
  resolve: (p: AIConfig['provider']) => AIProvider | null = (p) => providerFor(p),
): Promise<InferResult> {
  const camera = req.operation === 'vision_extract';
  const chain: Array<{ provider: AIProvider; model: string }> = [];
  const main = resolve(cfg.provider);
  const mainModel = camera ? cfg.visionModel : cfg.textModel;
  if (main && (!camera || main.supportsVision(mainModel))) chain.push({ provider: main, model: mainModel });
  const fb = cfg.fallbackProvider !== cfg.provider ? resolve(cfg.fallbackProvider) : null;
  if (fb && cfg.fallbackModel && (!camera || fb.supportsVision(cfg.fallbackModel))) chain.push({ provider: fb, model: cfg.fallbackModel });
  if (!chain.length) return { ok: false, reason: 'unavailable' };

  // Compact context: keep the most recent messages within the configured budget (§23, §40).
  const messages: AIMessage[] = [];
  let budget = cfg.maxInputChars;
  for (const m of [...req.messages].reverse()) {
    if (m.content.length > budget && messages.length) break;
    messages.unshift({ role: m.role, content: m.content.slice(-budget) });
    budget -= m.content.length;
  }
  const rates = ratesFrom();

  for (let attempt = 1, i = 0; attempt <= 2 && i < chain.length; attempt++) {
    const { provider, model } = chain[i]!;
    const reserved = await supabase.rpc('ai_reserve', { p_operation: req.operation, p_camera: camera, p_images: req.images?.length ?? 0 });
    if (reserved.error) {
      const code = RESERVE_ERRORS.find((c) => reserved.error!.message.includes(c));
      return { ok: false, reason: code ?? 'failed' };
    }
    const callId = (reserved.data as { call_id: number }).call_id;
    const settle = (usage: AIUsage, outcome: 'ok' | 'error' | 'timeout' | 'invalid_output', latency: number) => supabase.rpc('ai_record', {
      p_call_id: callId, p_provider: provider.name, p_model: model.slice(0, 80), p_input: usage.input, p_output: usage.output, p_cached: usage.cached,
      p_image: usage.image, p_cost_micro_usd: estimateCostMicroUsd(model, usage, rates), p_latency_ms: latency, p_attempt: attempt, p_outcome: outcome,
    });
    const started = Date.now();
    try {
      const r = await provider.complete({ operation: req.operation, model, system: req.system, messages, images: req.images, json: req.json,
        maxOutputTokens: cfg.maxOutput[req.operation], reasoning: cfg.reasoning, timeoutMs: cfg.timeoutMs });
      if (!validate(r.text)) {
        // A malformed answer is recorded (it cost tokens) but not retried: a retry would double the cost (§62).
        await settle(r.usage, 'invalid_output', r.latencyMs);
        return { ok: false, reason: 'failed' };
      }
      await settle(r.usage, 'ok', r.latencyMs);
      return { ok: true, text: r.text, usage: r.usage, provider: provider.name, model: r.model };
    } catch (e) {
      const err = e instanceof AIProviderError ? e : new AIProviderError('http', 'unexpected', false);
      await settle(err.usage ?? ZERO_USAGE, OUTCOME[err.kind] ?? 'error', Date.now() - started);
      if (!err.retryable && err.kind !== 'unsupported') i++; // permanent: only a different provider may help
      else if (err.kind === 'unsupported') i++;
    }
  }
  return { ok: false, reason: 'failed' };
}

/** Human copy for a stop (§49): no urgency, never blocks the rest of the product. */
export const STOP_TEXT: Record<AIStop, string> = {
  ai_quota: 'Llegaste al uso incluido de conversación este mes. Puedes seguir el próximo mes o ampliar tu uso con Plus. Todo lo demás sigue funcionando.',
  camera_quota: 'Ya usaste las lecturas con cámara incluidas. Puedes escribir el dato o ampliar tu uso con Plus.',
  ai_rate: 'Hiciste muchas consultas seguidas. Espera un momento y vuelve a intentar.',
  ai_budget: 'Ahora no puedo responder eso. Intenta más tarde; tus datos y cálculos siguen disponibles.',
  too_many_images: 'Envía como máximo 3 imágenes por lectura.',
  unavailable: 'Esa respuesta necesita la conversación inteligente, que todavía no está activa. Puedes escribir los datos o usar el resto de Velsuno.',
  failed: 'No pude leer eso bien. Intenta de nuevo o escríbelo con otras palabras.',
};
