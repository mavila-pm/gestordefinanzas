import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { infer } from '../lib/ai';
import { aiConfig } from '../src/ai/config';
import { AIError, type AIModel, type AIRequest } from '../src/ai/model';
import { geminiError } from '../src/ai/gemini';
import { checkImage as readImage } from '../src/ai/image';

/** Resilience of the AI door (ADR-0006): no key needed. Every attempt is reserved and recorded; ≤ 2 attempts. */
function fakeDb(reserveError?: string) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let id = 0;
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'ai_reserve') return reserveError ? { data: null, error: { message: reserveError } } : { data: { call_id: ++id }, error: null };
      return { data: null, error: null };
    },
  };
  return { db: db as never, calls, outcomes: () => calls.filter((c) => c.fn === 'ai_record').map((c) => c.args.p_outcome), reserves: () => calls.filter((c) => c.fn === 'ai_reserve').length };
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
  it('timeout once → one retry succeeds; both attempts reserved and recorded (timeout, ok)', async () => {
    const f = fakeDb();
    const seen: AIRequest[] = [];
    const main = scripted('gemini', [new AIError('timeout', 't', true), 'ok'], seen);
    const r = await infer(f.db, req, isJson, cfg(), main);
    expect(r.ok).toBe(true);
    expect(f.outcomes()).toEqual(['timeout', 'ok']);
    expect(seen.every((s) => s.timeoutMs === 15000)).toBe(true);
  });
  it('5xx twice → stops after 2 attempts (no retry storm)', async () => {
    const f = fakeDb();
    const main = scripted('gemini', [new AIError('http', '503', true), new AIError('http', '503', true), 'ok']);
    expect(await infer(f.db, req, isJson, cfg(), main)).toEqual({ ok: false, reason: 'failed' });
    expect(f.reserves()).toBe(2);
  });
  it('4xx is permanent: one attempt, no retry', async () => {
    const a = fakeDb();
    const m1 = scripted('gemini', [new AIError('http', '400', false), 'ok']);
    expect(await infer(a.db, req, isJson, cfg(), m1)).toEqual({ ok: false, reason: 'failed' });
    expect(a.reserves()).toBe(1);
  });
  it('rate limit once → one retry; empty answer (invalid_output from the adapter) is final', async () => {
    const a = fakeDb();
    const m1 = scripted('gemini', [new AIError('rate_limited', '429', true), 'ok']);
    expect((await infer(a.db, req, isJson, cfg(), m1)).ok).toBe(true);
    const b = fakeDb();
    const m2 = scripted('gemini', [new AIError('invalid_output', 'empty completion', false), 'ok']);
    expect(await infer(b.db, req, isJson, cfg(), m2)).toEqual({ ok: false, reason: 'failed' });
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
