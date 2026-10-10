import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { aiConfig, aiModel, type AIConfig } from '../src/ai/config';
import { AIError, ZERO_USAGE, type AIImage, type AIMessage, type AIModel, type AIUsage } from '../src/ai/model';
import { estimateCostMicroUsd, ratesFrom } from '../src/ai/pricing';
import type { Operation } from '../src/ai/types';

/**
 * The only door to Gemini (ADR-0006, ADR-0015). Every call is: reserve (quota, rate limit, cost guards, under the
 * user's session) → Gemini → settle with the usage Gemini reported. At most one retry, and only for transient
 * failures (timeout, 5xx, rate limit); 4xx and invalid output are final (§62). Every call asks for one JSON object;
 * the caller validates it. Nothing here logs prompts, answers or images.
 */
export type AIStop = 'ai_quota' | 'camera_quota' | 'ai_rate' | 'ai_budget' | 'too_many_images' | 'unavailable' | 'failed';
export type InferResult = { ok: true; text: string; usage: AIUsage; provider: string; model: string } | { ok: false; reason: AIStop };

const RESERVE_ERRORS: readonly AIStop[] = ['ai_quota', 'camera_quota', 'ai_rate', 'ai_budget', 'too_many_images'];
const OUTCOME: Record<string, 'error' | 'timeout' | 'invalid_output'> = { timeout: 'timeout', invalid_output: 'invalid_output' };

/**
 * Safe diagnostic for a failed call: normalized kind, HTTP status, model, latency, attempt. Never Gemini's
 * message, the prompt, the answer, account data or the key.
 */
export function diagnose(d: { kind: string; status: number | null; model: string; latencyMs: number; attempt: number }): void {
  console.warn(JSON.stringify({ event: 'ai_call_failed', kind: d.kind, status: d.status, model: d.model.slice(0, 80), latency_ms: d.latencyMs, attempt: d.attempt }));
}

export async function infer(
  supabase: SupabaseClient,
  req: { operation: Operation; system: string; messages: AIMessage[]; images?: AIImage[]; schema?: Record<string, unknown>; maxOutputTokens?: number },
  validate: (text: string) => boolean = () => true,
  cfg: AIConfig = aiConfig(),
  ai: AIModel | null = aiModel(),
): Promise<InferResult> {
  const camera = req.operation === 'vision_extract';
  const model = cfg.model;
  if (!ai) return { ok: false, reason: 'unavailable' };

  // Compact context: keep the most recent messages within the configured budget (§23, §40).
  const messages: AIMessage[] = [];
  let budget = cfg.maxInputChars;
  for (const m of [...req.messages].reverse()) {
    if (m.content.length > budget && messages.length) break;
    messages.unshift({ role: m.role, content: m.content.slice(-budget) });
    budget -= m.content.length;
  }
  const rates = ratesFrom();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reserved = await supabase.rpc('ai_reserve', { p_operation: req.operation, p_camera: camera, p_images: req.images?.length ?? 0 });
    if (reserved.error) {
      const code = RESERVE_ERRORS.find((c) => reserved.error!.message.includes(c));
      return { ok: false, reason: code ?? 'failed' };
    }
    const callId = (reserved.data as { call_id: number }).call_id;
    const settle = (usage: AIUsage, outcome: 'ok' | 'error' | 'timeout' | 'invalid_output', latency: number) => supabase.rpc('ai_record', {
      p_call_id: callId, p_provider: ai.name, p_model: model.slice(0, 80), p_input: usage.input, p_output: usage.output, p_cached: usage.cached,
      p_image: usage.image, p_cost_micro_usd: estimateCostMicroUsd(model, usage, rates), p_latency_ms: latency, p_attempt: attempt, p_outcome: outcome,
    });
    const started = Date.now();
    try {
      const r = await ai.complete({ operation: req.operation, model, system: req.system, messages, images: req.images, schema: req.schema,
        // A caller may ask for less output, never more than the configured cap.
        maxOutputTokens: Math.min(req.maxOutputTokens ?? Infinity, cfg.maxOutput[req.operation]), reasoning: cfg.reasoning, timeoutMs: cfg.timeoutMs });
      if (!validate(r.text)) {
        // A malformed answer is recorded (it cost tokens) but not retried: a retry would double the cost (§62).
        await settle(r.usage, 'invalid_output', r.latencyMs);
        diagnose({ kind: 'invalid_output', status: null, model, latencyMs: r.latencyMs, attempt });
        return { ok: false, reason: 'failed' };
      }
      await settle(r.usage, 'ok', r.latencyMs);
      return { ok: true, text: r.text, usage: r.usage, provider: ai.name, model: r.model };
    } catch (e) {
      const err = e instanceof AIError ? e : new AIError('http', 'unexpected', false);
      const latencyMs = Date.now() - started;
      await settle(err.usage ?? ZERO_USAGE, OUTCOME[err.kind] ?? 'error', latencyMs);
      diagnose({ kind: err.kind, status: err.status, model, latencyMs, attempt });
      if (!err.retryable) break; // permanent (4xx, unsupported, empty answer): a retry would fail the same way
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
