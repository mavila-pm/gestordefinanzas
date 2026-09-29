import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { infer } from '../lib/ai';
import { aiConfig } from '../src/ai/config';
import { AIProviderError, postJson, type AIProvider, type AIRequest } from '../src/ai/provider';
import { checkImage as readImage } from '../src/ai/image';

/** Provider-independent resilience (ADR-0006): no key needed. Every attempt is reserved and recorded; ≤ 2 attempts. */
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
const provider = (name: string, script: Array<'ok' | 'bad' | AIProviderError>, seen: AIRequest[] = []): AIProvider => ({
  name, supportsVision: () => true,
  complete: async (req) => {
    seen.push(req);
    const step = script.shift() ?? 'ok';
    if (step instanceof AIProviderError) throw step;
    return { text: step === 'ok' ? '{"ok":true}' : 'not json', usage: { input: 10, output: 5, cached: 0, image: 0 }, model: req.model, latencyMs: 3 };
  },
});
const cfg = (fallback = false) => ({ ...aiConfig({ AI_PROVIDER: 'deepseek' }), fallbackProvider: fallback ? 'gemini' as const : 'none' as const, fallbackModel: fallback ? 'fb-model' : '' });
const req = { operation: 'assistant_answer' as const, system: 's', messages: [{ role: 'user' as const, content: 'hola' }], json: true };
const isJson = (t: string) => { try { JSON.parse(t); return true; } catch { return false; } };

describe('AI resilience without a provider key', () => {
  it('no provider configured → "unavailable", nothing reserved or charged', async () => {
    const f = fakeDb();
    expect(await infer(f.db, req, isJson, aiConfig({}), () => null)).toEqual({ ok: false, reason: 'unavailable' });
    expect(f.calls).toHaveLength(0);
  });
  it('timeout once → one retry succeeds; both attempts reserved and recorded (timeout, ok)', async () => {
    const f = fakeDb();
    const seen: AIRequest[] = [];
    const main = provider('deepseek', [new AIProviderError('timeout', 't', true), 'ok'], seen);
    const r = await infer(f.db, req, isJson, cfg(), (p) => (p === 'deepseek' ? main : null));
    expect(r.ok).toBe(true);
    expect(f.outcomes()).toEqual(['timeout', 'ok']);
    expect(seen.every((s) => s.timeoutMs === 15000)).toBe(true);
  });
  it('5xx twice → stops after 2 attempts (no retry storm)', async () => {
    const f = fakeDb();
    const main = provider('deepseek', [new AIProviderError('http', '503', true), new AIProviderError('http', '503', true), 'ok']);
    expect(await infer(f.db, req, isJson, cfg(), (p) => (p === 'deepseek' ? main : null))).toEqual({ ok: false, reason: 'failed' });
    expect(f.reserves()).toBe(2);
  });
  it('4xx is permanent: no retry on the same provider; the fallback (if any) gets one try', async () => {
    const a = fakeDb();
    const m1 = provider('deepseek', [new AIProviderError('http', '400', false)]);
    expect(await infer(a.db, req, isJson, cfg(), (p) => (p === 'deepseek' ? m1 : null))).toEqual({ ok: false, reason: 'failed' });
    expect(a.reserves()).toBe(1);
    const b = fakeDb();
    const m2 = provider('deepseek', [new AIProviderError('http', '401', false)]);
    const fb = provider('gemini', ['ok']);
    const r = await infer(b.db, req, isJson, cfg(true), (p) => (p === 'deepseek' ? m2 : p === 'gemini' ? fb : null));
    expect(r).toMatchObject({ ok: true, provider: 'gemini' });
    expect(b.outcomes()).toEqual(['error', 'ok']);
  });
  it('invalid output (schema) → recorded, never retried (a retry would double the cost)', async () => {
    const f = fakeDb();
    const main = provider('deepseek', ['bad', 'ok']);
    expect(await infer(f.db, req, isJson, cfg(), (p) => (p === 'deepseek' ? main : null))).toEqual({ ok: false, reason: 'failed' });
    expect(f.outcomes()).toEqual(['invalid_output']);
  });
  it('quota / rate / budget refused at reserve → the provider is never called', async () => {
    for (const reason of ['ai_quota', 'camera_quota', 'ai_rate', 'ai_budget'] as const) {
      const f = fakeDb(`${reason}: stop`);
      const seen: AIRequest[] = [];
      const main = provider('deepseek', ['ok'], seen);
      expect(await infer(f.db, req, isJson, cfg(), (p) => (p === 'deepseek' ? main : null))).toEqual({ ok: false, reason });
      expect(seen).toHaveLength(0);
    }
  });
  it('postJson: 429 → retryable rate limit; 400/401 → permanent; 500/503 → retryable; abort → timeout; network → retryable', async () => {
    const res = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    const kind = async (f: typeof fetch, ms = 1000) => { try { await postJson('https://x.invalid', {}, {}, ms, f); return 'ok'; } catch (e) { const x = e as AIProviderError; return `${x.kind}:${x.retryable}`; } };
    expect(await kind(res(429))).toBe('rate_limited:true');
    expect(await kind(res(400))).toBe('http:false');
    expect(await kind(res(401))).toBe('http:false');
    expect(await kind(res(503))).toBe('http:true');
    expect(await kind(res(200))).toBe('ok');
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    expect(await kind(hang, 20)).toBe('timeout:true');
    expect(await kind((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).toBe('http:true');
  });
  it('image intake: wrong type, empty, oversized and disguised files are refused before any provider call', () => {
    expect(readImage(new Uint8Array())).toMatchObject({ ok: false, error: 'empty' });
    expect(readImage(new TextEncoder().encode('%PDF-1.7 not an image'))).toMatchObject({ ok: false, error: 'unsupported' });
    expect(readImage(new Uint8Array(7 * 1024 * 1024).fill(0xff))).toMatchObject({ ok: false, error: 'too_large' });
    expect(readImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toMatchObject({ ok: false });
  });
});
