import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { aiConfig, aiModel, type AIConfig } from '../src/ai/config';
import { AIError, ZERO_USAGE, type AIFailure, type AIImage, type AIMessage, type AIModel, type AIUsage } from '../src/ai/model';
import { ceilingCostMicroUsd, estimateCostMicroUsd, ratesFrom } from '../src/ai/pricing';
import type { Operation } from '../src/ai/types';

/**
 * The only door to Gemini (ADR-0006, ADR-0015, ADR-0020). Every call is: reserve (quota, rate limit, cost guards,
 * under the user's session) → Gemini → settle with the usage Gemini reported. One total deadline bounds the whole
 * turn (≤ 20 s by default): at most one retry, only for transient failures (5xx, rate limit, network; a timeout is
 * retried only by the camera read) and only if enough time is left. 4xx and invalid output are final (§62). Every
 * call asks for one JSON object; the caller validates it. Nothing here logs prompts, answers or images.
 */
export type AIStop = 'ai_quota' | 'camera_quota' | 'ai_rate' | 'ai_budget' | 'too_many_images' | 'unavailable' | 'busy' | 'failed';
export type InferResult = { ok: true; text: string; usage: AIUsage; provider: string; model: string } | { ok: false; reason: AIStop };

const RESERVE_ERRORS: readonly AIStop[] = ['ai_quota', 'camera_quota', 'ai_rate', 'ai_budget', 'too_many_images'];
const OUTCOME: Record<string, 'error' | 'timeout' | 'invalid_output'> = { timeout: 'timeout', invalid_output: 'invalid_output' };
/** Failures on our side or the provider's (slow, overloaded, unreachable): the person is told so, never blamed. */
const BUSY: ReadonlySet<AIFailure> = new Set(['timeout', 'http', 'rate_limited']);
/** A slow text answer is not retried: a second wait would double the turn (real data: timeouts at 15 s). */
const NO_RETRY_AFTER_TIMEOUT: ReadonlySet<Operation> = new Set(['assistant_answer', 'onboarding_extract']);
/** A retry starts only with at least this much of the deadline left (else it could only time out). */
export const MIN_ATTEMPT_MS = 3000;
/** ai_record with the failure diagnostics (migration 20261020000058); the 11-argument form stays for old databases. */
const MISSING_FUNCTION = new Set(['PGRST202', '42883']);

/**
 * Safe diagnostic for a failed call: normalized kind, HTTP status, model, latency, attempt. Never Gemini's
 * message, the prompt, the answer, account data or the key.
 */
export function diagnose(d: { kind: string; status: number | null; model: string; latencyMs: number; attempt: number }): void {
  console.warn(JSON.stringify({ event: 'ai_call_failed', kind: d.kind, status: d.status, model: d.model.slice(0, 80), latency_ms: d.latencyMs, attempt: d.attempt }));
}

export async function infer(
  supabase: SupabaseClient,
  req: { operation: Operation; system: string; messages: AIMessage[]; images?: AIImage[]; schema?: Record<string, unknown>; maxOutputTokens?: number;
    /** Total time for the whole call, retries included (default: the configured deadline). */ deadlineMs?: number },
  validate: (text: string) => boolean = () => true,
  cfg: AIConfig = aiConfig(),
  ai: AIModel | null = aiModel(),
): Promise<InferResult> {
  const camera = req.operation === 'vision_extract';
  const model = cfg.model;
  if (!ai) return { ok: false, reason: 'unavailable' };
  const deadline = Date.now() + Math.max(1, Math.min(req.deadlineMs ?? cfg.deadlineMs, cfg.deadlineMs));

  // Compact context: keep the most recent messages within the configured budget (§23, §40).
  const messages: AIMessage[] = [];
  let budget = cfg.maxInputChars;
  for (const m of [...req.messages].reverse()) {
    if (m.content.length > budget && messages.length) break;
    messages.unshift({ role: m.role, content: m.content.slice(-budget) });
    budget -= m.content.length;
  }
  const rates = ratesFrom();
  // A caller may ask for less output, never more than the configured cap.
  const maxOutputTokens = Math.min(req.maxOutputTokens ?? Infinity, cfg.maxOutput[req.operation]);
  // What a call whose usage never came back (timeout) could have cost: counted in the cost guards (fail safe).
  const ceiling = ceilingCostMicroUsd(model, { inputChars: req.system.length + messages.reduce((n, m) => n + m.content.length, 0), maxOutputTokens, images: req.images?.length ?? 0 }, rates);
  let last: AIFailure | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reserved = await supabase.rpc('ai_reserve', { p_operation: req.operation, p_camera: camera, p_images: req.images?.length ?? 0 });
    if (reserved.error) {
      const code = RESERVE_ERRORS.find((c) => reserved.error!.message.includes(c));
      return { ok: false, reason: code ?? (attempt > 1 && last && BUSY.has(last) ? 'busy' : 'failed') };
    }
    const callId = (reserved.data as { call_id: number }).call_id;
    // Settles exactly once. A failed ai_record is reported (the call would stay pending, uncharged); it never hides the answer.
    const settle = async (usage: AIUsage, outcome: 'ok' | 'error' | 'timeout' | 'invalid_output', latency: number,
      failure: { kind: AIFailure; status: number | null } | null = null, cost = estimateCostMicroUsd(model, usage, rates)) => {
      const base = { p_call_id: callId, p_provider: ai.name, p_model: model.slice(0, 80), p_input: usage.input, p_output: usage.output, p_cached: usage.cached,
        p_image: usage.image, p_cost_micro_usd: cost, p_latency_ms: latency, p_attempt: attempt, p_outcome: outcome };
      try {
        let res = await supabase.rpc('ai_record', failure ? { ...base, p_error_kind: failure.kind, p_http_status: failure.status } : base);
        if (failure && res.error && MISSING_FUNCTION.has(res.error.code)) res = await supabase.rpc('ai_record', base);
        if (res.error) diagnose({ kind: 'record_failed', status: null, model, latencyMs: latency, attempt });
      } catch {
        diagnose({ kind: 'record_failed', status: null, model, latencyMs: latency, attempt });
      }
    };
    const started = Date.now();
    const timeoutMs = Math.max(1, Math.min(cfg.timeoutMs, deadline - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The adapter aborts at timeoutMs; this guard holds the deadline even if a model never answers nor aborts.
      const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AIError('timeout', 'deadline', true)), timeoutMs); });
      const r = await Promise.race([ai.complete({ operation: req.operation, model, system: req.system, messages, images: req.images, schema: req.schema,
        maxOutputTokens, reasoning: cfg.reasoning, timeoutMs }), guard]);
      clearTimeout(timer);
      if (!validate(r.text)) {
        // A malformed answer is recorded (it cost tokens) but not retried: a retry would double the cost (§62).
        await settle(r.usage, 'invalid_output', r.latencyMs, { kind: 'invalid_output', status: null });
        diagnose({ kind: 'invalid_output', status: null, model, latencyMs: r.latencyMs, attempt });
        return { ok: false, reason: 'failed' };
      }
      await settle(r.usage, 'ok', r.latencyMs);
      return { ok: true, text: r.text, usage: r.usage, provider: ai.name, model: r.model };
    } catch (e) {
      clearTimeout(timer);
      const err = e instanceof AIError ? e : new AIError('http', 'unexpected', false);
      const latencyMs = Date.now() - started;
      last = err.kind;
      // A timeout reports no usage: no tokens are charged to the person, but the cost guards count its ceiling.
      const timedOut = err.kind === 'timeout' && !err.usage;
      await settle(err.usage ?? ZERO_USAGE, OUTCOME[err.kind] ?? 'error', latencyMs, { kind: err.kind, status: err.status }, timedOut ? ceiling : undefined);
      diagnose({ kind: err.kind, status: err.status, model, latencyMs, attempt });
      if (!err.retryable) break; // permanent (4xx, unsupported, empty answer): a retry would fail the same way
      if (err.kind === 'timeout' && NO_RETRY_AFTER_TIMEOUT.has(req.operation)) break;
      if (deadline - Date.now() < MIN_ATTEMPT_MS) break; // no time left for a useful second try
    }
  }
  return { ok: false, reason: last && BUSY.has(last) ? 'busy' : 'failed' };
}

/** Human copy for a stop (§49): no urgency, never blocks the rest of the product. */
export const STOP_TEXT: Record<AIStop, string> = {
  ai_quota: 'Llegaste al uso incluido de conversación este mes. Puedes seguir el próximo mes o ampliar tu uso con Plus. Todo lo demás sigue funcionando.',
  camera_quota: 'Ya usaste las lecturas con cámara incluidas. Puedes escribir el dato o ampliar tu uso con Plus.',
  ai_rate: 'Hiciste muchas consultas seguidas. Espera un momento y vuelve a intentar.',
  ai_budget: 'Ahora no puedo responder eso. Intenta más tarde; tus datos y cálculos siguen disponibles.',
  too_many_images: 'Envía como máximo 3 imágenes por lectura.',
  unavailable: 'Esa respuesta necesita la conversación inteligente, que todavía no está activa. Puedes escribir los datos o usar el resto de Velsuno.',
  busy: 'Tardé demasiado en responder. Intenta de nuevo en un momento.',
  failed: 'No pude leer eso bien. Intenta de nuevo o escríbelo con otras palabras.',
};
