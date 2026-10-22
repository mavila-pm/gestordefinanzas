import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { infer, MIN_ATTEMPT_MS } from '../lib/ai';
import { aiConfig } from '../src/ai/config';
import { ceilingCostMicroUsd, ratesFrom, UNPRICED_CEILING } from '../src/ai/pricing';
import { AIError, type AIModel, type AIRequest } from '../src/ai/model';
import { geminiError } from '../src/ai/gemini';
import { checkImage as readImage } from '../src/ai/image';

/** Resilience of the AI door (ADR-0006): no key needed. Every attempt is reserved and recorded; ≤ 2 attempts. */
function fakeDb(reserveError?: string, recordError?: (args: Record<string, unknown>) => { message: string; code: string } | null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let id = 0;
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'ai_reserve') return reserveError ? { data: null, error: { message: reserveError } } : { data: { call_id: ++id }, error: null };
      return { data: null, error: recordError?.(args) ?? null };
    },
  };
  const records = () => calls.filter((c) => c.fn === 'ai_record').map((c) => c.args);
  return { db: db as never, calls, records, outcomes: () => records().map((a) => a.p_outcome), reserves: () => calls.filter((c) => c.fn === 'ai_reserve').length };
}
const scripted = (name: string, script: Array<'ok' | 'bad' | AIError>, seen: AIRequest[] = []): AIModel => ({
  name,
  complete: async (req) => {
    seen.push(req);
    const step = script.shift() ?? 'ok';
    if (step instanceof AIError) throw step;
    return { text: step === 'ok' ? '{"ok":true}' : 'not json', usage: { input: 10, output: 5, cached: 0, image: 0 }, model: req.model, latencyMs: 3 };
  },
});
const cfg = () => aiConfig({});
const req = { operation: 'assistant_answer' as const, system: 's', messages: [{ role: 'user' as const, content: 'hola' }] };
const isJson = (t: string) => { try { JSON.parse(t); return true; } catch { return false; } };

describe('AI resilience without a Gemini key', () => {
  it('no model configured → "unavailable", nothing reserved or charged', async () => {
    const f = fakeDb();
    expect(await infer(f.db, req, isJson, aiConfig({}), null)).toEqual({ ok: false, reason: 'unavailable' });
    expect(f.calls).toHaveLength(0);
  });
  it('a text answer that times out is not retried (the turn would double): "busy", one reservation, recorded as timeout', async () => {
    for (const operation of ['assistant_answer', 'onboarding_extract'] as const) {
      const f = fakeDb();
      const seen: AIRequest[] = [];
      const main = scripted('gemini', [new AIError('timeout', 't', true), 'ok'], seen);
      expect(await infer(f.db, { ...req, operation }, isJson, cfg(), main)).toEqual({ ok: false, reason: 'busy' });
      expect(f.reserves()).toBe(1);
      expect(f.outcomes()).toEqual(['timeout']);
      expect(seen[0]!.timeoutMs).toBe(15000);
    }
  });
  it('a camera read that times out is retried once while the deadline leaves time (timeout, ok)', async () => {
    const f = fakeDb();
    const main = scripted('gemini', [new AIError('timeout', 't', true), 'ok']);
    const r = await infer(f.db, { ...req, operation: 'vision_extract', images: [{ mime: 'image/png', base64: 'AA==' }] }, isJson, cfg(), main);
    expect(r.ok).toBe(true);
    expect(f.outcomes()).toEqual(['timeout', 'ok']);
  });
  it('5xx twice → stops after 2 attempts (no retry storm) and says "busy", never "not understood"', async () => {
    const f = fakeDb();
    const main = scripted('gemini', [new AIError('http', '503', true, null, 503), new AIError('http', '503', true, null, 503), 'ok']);
    expect(await infer(f.db, req, isJson, cfg(), main)).toEqual({ ok: false, reason: 'busy' });
    expect(f.reserves()).toBe(2);
  });
  it('4xx is permanent: one attempt, no retry; it is our side, so "busy" (not the person\'s fault)', async () => {
    const a = fakeDb();
    const m1 = scripted('gemini', [new AIError('http', '400', false, null, 400), 'ok']);
    expect(await infer(a.db, req, isJson, cfg(), m1)).toEqual({ ok: false, reason: 'busy' });
    expect(a.reserves()).toBe(1);
  });
  it('total deadline: a model that never answers returns within it, with ONE reservation settled once as a timeout', async () => {
    const f = fakeDb();
    let calls = 0;
    const hanging: AIModel = { name: 'gemini', complete: () => { calls++; return new Promise(() => {}); } };
    const t0 = Date.now();
    const r = await infer(f.db, { ...req, deadlineMs: 80 }, isJson, cfg(), hanging);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r).toEqual({ ok: false, reason: 'busy' });
    expect(calls).toBe(1);
    expect(f.reserves()).toBe(1);
    expect(f.outcomes()).toEqual(['timeout']);
    // The configured deadline is ≤ 20 s and a caller can only shorten it.
    expect(aiConfig({}).deadlineMs).toBeLessThanOrEqual(20000);
    expect(aiConfig({ AI_DEADLINE_MS: '999999' }).deadlineMs).toBe(20000);
  });
  it('no second attempt unless enough of the deadline is left', async () => {
    const f = fakeDb();
    const main = scripted('gemini', [new AIError('http', '503', true, null, 503), 'ok']);
    expect(await infer(f.db, { ...req, deadlineMs: MIN_ATTEMPT_MS - 500 }, isJson, cfg(), main)).toEqual({ ok: false, reason: 'busy' });
    expect(f.reserves()).toBe(1);
  });
  it('fail-safe cost: a timeout charges no tokens to the person but its ceiling cost to the guards; kind and status recorded', async () => {
    const f = fakeDb();
    await infer(f.db, { ...req, system: 'x'.repeat(400) }, isJson, cfg(), scripted('gemini', [new AIError('timeout', 't', true)]));
    const [rec] = f.records();
    expect(rec).toMatchObject({ p_outcome: 'timeout', p_input: 0, p_output: 0, p_cached: 0, p_image: 0, p_error_kind: 'timeout', p_http_status: null });
    // Unpriced model: (404 chars / 4 → 101 tokens) × 2 + 1024 output tokens × 12 micro-USD.
    expect(rec!.p_cost_micro_usd).toBe(ceilingCostMicroUsd('gemini-3.8-flash', { inputChars: 404, maxOutputTokens: 1024, images: 0 }, ratesFrom({})));
    expect(rec!.p_cost_micro_usd).toBe(Math.ceil((101 * UNPRICED_CEILING.in + 1024 * UNPRICED_CEILING.out) / 1_000_000));
    // A 429 is recorded with its status (and the usage it reported: none → no cost).
    const g = fakeDb();
    await infer(g.db, req, isJson, cfg(), scripted('gemini', [new AIError('rate_limited', '429', true, null, 429), new AIError('rate_limited', '429', true, null, 429)]));
    expect(g.records().map((a) => [a.p_outcome, a.p_error_kind, a.p_http_status, a.p_cost_micro_usd])).toEqual([['error', 'rate_limited', 429, 0], ['error', 'rate_limited', 429, 0]]);
    // A successful call carries no failure fields (the 11-argument ai_record).
    const h = fakeDb();
    await infer(h.db, req, isJson, cfg(), scripted('gemini', ['ok']));
    expect(Object.keys(h.records()[0]!)).not.toContain('p_error_kind');
  });
  it('a failed ai_record is reported (kind record_failed, no content); before the migration it falls back to the old signature', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeDb(undefined, () => ({ message: 'permission denied for S/ 2,400', code: '42501' }));
    const r = await infer(f.db, { ...req, messages: [{ role: 'user', content: 'saldo S/ 2,400' }] }, isJson, cfg(), scripted('gemini', ['ok']));
    expect(r.ok).toBe(true); // the answer is not lost
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged.map((l) => JSON.parse(l).kind)).toEqual(['record_failed']);
    expect(logged.join()).not.toMatch(/2,400|saldo|permission/);
    warn.mockClear();
    const old = fakeDb(undefined, (args) => ('p_error_kind' in args ? { message: 'Could not find the function', code: 'PGRST202' } : null));
    await infer(old.db, req, isJson, cfg(), scripted('gemini', [new AIError('http', '400', false, null, 400)]));
    expect(old.records().map((a) => 'p_error_kind' in a)).toEqual([true, false]);
    expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).kind)).toEqual(['http']);
    warn.mockRestore();
  });
  it('rate limit once → one retry; empty answer (invalid_output from the adapter) is final', async () => {
    const a = fakeDb();
    const m1 = scripted('gemini', [new AIError('rate_limited', '429', true), 'ok']);
    expect((await infer(a.db, req, isJson, cfg(), m1)).ok).toBe(true);
    const b = fakeDb();
    const m2 = scripted('gemini', [new AIError('invalid_output', 'empty completion', false), 'ok']);
    expect(await infer(b.db, req, isJson, cfg(), m2)).toEqual({ ok: false, reason: 'failed' });
    expect(b.records()[0]).toMatchObject({ p_error_kind: 'invalid_output', p_http_status: null });
    expect(b.outcomes()).toEqual(['invalid_output']);
  });
  it('invalid output (schema) → recorded, never retried (a retry would double the cost)', async () => {
    const f = fakeDb();
    const main = scripted('gemini', ['bad', 'ok']);
    expect(await infer(f.db, req, isJson, cfg(), main)).toEqual({ ok: false, reason: 'failed' });
    expect(f.outcomes()).toEqual(['invalid_output']);
  });
  it('quota / rate / budget refused at reserve → the provider is never called', async () => {
    for (const reason of ['ai_quota', 'camera_quota', 'ai_rate', 'ai_budget'] as const) {
      const f = fakeDb(`${reason}: stop`);
      const seen: AIRequest[] = [];
      const main = scripted('gemini', ['ok'], seen);
      expect(await infer(f.db, req, isJson, cfg(), main)).toEqual({ ok: false, reason });
      expect(seen).toHaveLength(0);
    }
  });
  it('Gemini SDK errors: 429 → retryable rate limit; 400/401 → permanent; 5xx → retryable; abort → timeout; network → retryable', () => {
    const kind = (e: unknown, aborted = false) => { const x = geminiError(e, aborted); return `${x.kind}:${x.retryable}`; };
    const status = (n: number) => Object.assign(new Error('provider text with the prompt'), { status: n });
    expect(kind(status(429))).toBe('rate_limited:true');
    expect(kind(status(400))).toBe('http:false');
    expect(kind(status(401))).toBe('http:false');
    expect(kind(status(503))).toBe('http:true');
    expect(kind(new Error('aborted'), true)).toBe('timeout:true');
    expect(kind(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout:true');
    expect(kind(new TypeError('fetch failed'))).toBe('http:true');
    expect(geminiError(status(400), false).message).not.toContain('prompt');
  });
  it('image intake: wrong type, empty, oversized and disguised files are refused before any provider call', () => {
    expect(readImage(new Uint8Array())).toMatchObject({ ok: false, error: 'empty' });
    expect(readImage(new TextEncoder().encode('%PDF-1.7 not an image'))).toMatchObject({ ok: false, error: 'unsupported' });
    expect(readImage(new Uint8Array(7 * 1024 * 1024).fill(0xff))).toMatchObject({ ok: false, error: 'too_large' });
    expect(readImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toMatchObject({ ok: false });
  });
});
