import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { infer } from '../lib/ai';
import { answer, compactView, type View } from '../src/ai/assistant';
import { aiConfig, aiModel, GEMINI_DEFAULT_MODEL } from '../src/ai/config';
import { estimateCostMicroUsd, UNPRICED_CEILING } from '../src/ai/pricing';
import { gemini as geminiModel, geminiError, GEMINI_MIN_OUTPUT_TOKENS, type GeminiModels } from '../src/ai/gemini';
import { amountToMinor, replyGrounded, validateVelsRoute, VELS_ROUTE_SCHEMA, VELS_ROUTE_SYSTEM } from '../src/ai/vels-route';

/** Gemini is the only model; it interprets, the engine computes. No network, no key: the SDK models are stubbed. */

type Params = Parameters<GeminiModels['generateContent']>[0];
function stub(answerText: string | (() => never), seen: Params[] = []): GeminiModels {
  return { generateContent: async (p) => { seen.push(p); if (typeof answerText === 'function') answerText(); return { text: answerText as string, usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } }; } };
}
function fakeDb() {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return { db: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return fn === 'ai_reserve' ? { data: { call_id: 1 }, error: null } : { data: null, error: null }; } } as never, calls };
}

const STATE = 'Hoy: 2026-10-08\nPEN: saldo S/ 2,400.00; libre S/ 850.00 hasta 2026-10-15; separado S/ 1,550.00\n- Alquiler: S/ 1,200.00 (2026-10-10)';
const ctx = (question: string) => ({ state: STATE, question });

describe('config: Gemini only, model centralized, key server-side', () => {
  it('default model gemini-3.8-flash; GEMINI_MODEL swaps it without code; junk falls back', () => {
    expect(GEMINI_DEFAULT_MODEL).toBe('gemini-3.8-flash');
    expect(aiConfig({ GEMINI_API_KEY: 'k' }).model).toBe('gemini-3.8-flash');
    expect(aiConfig({ GEMINI_MODEL: 'gemini-4-flash' }).model).toBe('gemini-4-flash');
    expect(aiConfig({ GEMINI_MODEL: '../x?y' }).model).toBe(GEMINI_DEFAULT_MODEL);
  });
  it('Gemini only with the server key; NEXT_PUBLIC_GEMINI_API_KEY is never read; old provider settings do nothing', () => {
    expect(aiModel({ NEXT_PUBLIC_GEMINI_API_KEY: 'leak' })).toBeNull();
    expect(aiModel({ GEMINI_API_KEY: 'k' })?.name).toBe('gemini');
    expect(aiModel({ GEMINI_API_KEY: 'k', AI_PROVIDER: 'openrouter' })?.name).toBe('gemini');
    expect(aiModel({ AI_PROVIDER: 'fixture', AI_ALLOW_FIXTURE: '1' })).toBeNull();
  });
  it('the test fixture runs only with AI_FIXTURE=1 and never on a production deployment', () => {
    expect(aiModel({ AI_FIXTURE: '1' })?.name).toBe('fixture');
    expect(aiConfig({ AI_FIXTURE: '1' }).model).toBe('fixture');
    expect(aiModel({ AI_FIXTURE: '1', VERCEL_ENV: 'production' })).toBeNull();
    expect(aiModel({ AI_FIXTURE: '1', VERCEL_ENV: 'production', GEMINI_API_KEY: 'k' })?.name).toBe('gemini');
  });
  it('an unpriced model is costed at the guard ceiling, never at 0', () => {
    const u = { input: 1_000_000, output: 1_000_000, cached: 0, image: 0 };
    expect(estimateCostMicroUsd(GEMINI_DEFAULT_MODEL, u)).toBe(UNPRICED_CEILING.in + UNPRICED_CEILING.out);
  });
});

describe('Gemini adapter (official SDK)', () => {
  const req = { operation: 'assistant_answer' as const, model: GEMINI_DEFAULT_MODEL, system: VELS_ROUTE_SYSTEM, messages: [{ role: 'user' as const, content: '¿cuánto me sobra?' }],
    schema: VELS_ROUTE_SCHEMA, maxOutputTokens: 300, reasoning: 'off' as const, timeoutMs: 1000 };
  it('sends the model, system instruction, JSON mime type and the response schema; no key in the request', async () => {
    const seen: Params[] = [];
    const r = await geminiModel({ models: stub('{"intent":"free"}', seen) }).complete(req);
    expect(r).toMatchObject({ text: '{"intent":"free"}', usage: { input: 50, output: 10 } });
    expect(seen[0]).toMatchObject({ model: 'gemini-3.8-flash', config: { systemInstruction: VELS_ROUTE_SYSTEM, responseMimeType: 'application/json', responseJsonSchema: VELS_ROUTE_SCHEMA, maxOutputTokens: GEMINI_MIN_OUTPUT_TOKENS } });
    expect(JSON.stringify(seen[0])).not.toContain('apiKey');
  });
  it('empty answer → invalid_output (not retried); timeout → typed timeout', async () => {
    await expect(geminiModel({ models: stub('  ') }).complete(req)).rejects.toMatchObject({ kind: 'invalid_output', retryable: false });
    const hang: GeminiModels = { generateContent: (p) => new Promise((_r, reject) => p.config!.abortSignal!.addEventListener('abort', () => reject(new Error('aborted')))) };
    await expect(geminiModel({ models: hang }).complete({ ...req, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout', retryable: true });
  });
});

describe('Gemini 3.8 compatibility (regression: Preview calls refused with 4xx before generating)', () => {
  const base = { operation: 'assistant_answer' as const, model: 'gemini-3.8-flash', system: 's', messages: [{ role: 'user' as const, content: 'hola' }], maxOutputTokens: 300, timeoutMs: 1000 };
  it('never sends MINIMAL thinking: off/low → LOW, high → HIGH', async () => {
    for (const [reasoning, level] of [['off', 'LOW'], ['low', 'LOW'], ['high', 'HIGH']] as const) {
      const seen: Params[] = [];
      await geminiModel({ models: stub('{"intent":"free"}', seen) }).complete({ ...base, reasoning });
      expect(seen[0]!.config!.thinkingConfig).toEqual({ thinkingLevel: level });
      expect(JSON.stringify(seen[0])).not.toContain('MINIMAL');
    }
  });
  it('sends no temperature / topP / topK', async () => {
    const seen: Params[] = [];
    await geminiModel({ models: stub('{"intent":"free"}', seen) }).complete({ ...base, reasoning: 'off' });
    expect(seen[0]!.config).not.toHaveProperty('temperature');
    expect(seen[0]!.config).not.toHaveProperty('topP');
    expect(seen[0]!.config).not.toHaveProperty('topK');
  });
  it('a short answer gets room to think and reply: the 300-token request is raised to the floor, within the config cap', async () => {
    const seen: Params[] = [];
    await geminiModel({ models: stub('{"intent":"free"}', seen) }).complete({ ...base, reasoning: 'off' });
    expect(seen[0]!.config!.maxOutputTokens).toBe(GEMINI_MIN_OUTPUT_TOKENS);
    expect(GEMINI_MIN_OUTPUT_TOKENS).toBeLessThanOrEqual(aiConfig({}).maxOutput.assistant_answer);
    expect(aiConfig({ AI_MAX_OUTPUT_ASSISTANT_ANSWER: '300' }).maxOutput.assistant_answer).toBe(1024);
    // Through the door: the route asks for 300; Gemini receives the floor, never above the cap.
    const f = fakeDb();
    const seen2: Params[] = [];
    await infer(f.db, { operation: 'assistant_answer', system: 's', messages: [{ role: 'user', content: 'hola' }], maxOutputTokens: 300 },
      undefined, aiConfig({ GEMINI_API_KEY: 'k' }), geminiModel({ models: stub('{"intent":"free"}', seen2) }));
    expect(seen2[0]!.config!.maxOutputTokens).toBe(1024);
  });
  it('400 / 401 / 404 permanent, 429 rate limit (retryable), 5xx retryable; status kept, provider text dropped', () => {
    const err = (status: number) => geminiError(Object.assign(new Error('Thinking level MINIMAL is not supported for this model: <prompt echo>'), { status }), false);
    expect(err(400)).toMatchObject({ kind: 'http', retryable: false, status: 400 });
    expect(err(401)).toMatchObject({ kind: 'http', retryable: false, status: 401 });
    expect(err(404)).toMatchObject({ kind: 'http', retryable: false, status: 404 });
    expect(err(429)).toMatchObject({ kind: 'rate_limited', retryable: true, status: 429 });
    expect(err(500)).toMatchObject({ kind: 'http', retryable: true, status: 500 });
    expect(err(503)).toMatchObject({ kind: 'http', retryable: true, status: 503 });
    expect(err(400).message).not.toMatch(/MINIMAL|prompt/);
  });
  it('a failure logs only kind, status, model, latency and attempt (no prompt, no answer, no key)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeDb();
    const failing = geminiModel({ models: stub(() => { throw Object.assign(new Error('bad request about S/ 850 saldo'), { status: 400 }); }) });
    await infer(f.db, { operation: 'assistant_answer', system: 'SYSTEM-SECRET', messages: [{ role: 'user', content: 'ESTADO: saldo S/ 2,400' }] },
      undefined, aiConfig({ GEMINI_API_KEY: 'key-123' }), failing);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(JSON.parse(logged)).toEqual({ event: 'ai_call_failed', kind: 'http', status: 400, model: 'gemini-3.8-flash', latency_ms: expect.any(Number), attempt: 1 });
    for (const leak of ['SYSTEM-SECRET', '2,400', '850', 'key-123', 'bad request']) expect(logged).not.toContain(leak);
  });
});

describe('structured interpretation → engine intent (validated)', () => {
  it('valid intents map to the engine; amounts only when the person wrote them', () => {
    expect(validateVelsRoute('{"intent":"free"}', ctx('¿cuánto me sobra para el finde?'))).toEqual({ kind: 'intent', intent: { k: 'free' } });
    expect(validateVelsRoute('{"intent":"can_spend","amount":"300","currency":"PEN"}', ctx('¿me da para unas zapatillas de 300?')))
      .toEqual({ kind: 'intent', intent: { k: 'can_spend', amountMinor: 30000, currency: 'PEN' } });
    expect(validateVelsRoute('{"intent":"upcoming","range":"week"}', ctx('¿qué se me viene?'))).toEqual({ kind: 'intent', intent: { k: 'upcoming', range: 'week' } });
    expect(validateVelsRoute('{"intent":"owe","amount":"200","lender":"Rosa"}', ctx('a Rosa le tengo que devolver 200')))
      .toEqual({ kind: 'intent', intent: { k: 'owe', amountMinor: 20000, currency: 'PEN', lender: 'Rosa' } });
  });
  it('invalid output is rejected: not JSON, unknown intent, bad currency, invented or malformed amount, bad days', () => {
    const q = ctx('¿me da para unas zapatillas de 300?');
    for (const bad of ['esto no es json', '[]', '{"intent":"transfer_money"}', '{"intent":"can_spend","amount":"300","currency":"EUR"}',
      '{"intent":"can_spend","amount":"3000"}', '{"intent":"can_spend","amount":"-300"}', '{"intent":"can_spend","amount":"1e3"}', '{"intent":"can_spend"}',
      '{"intent":"what_delay","days":400}', '{"intent":"other"}', '{"intent":"other","reply":""}']) {
      expect(validateVelsRoute(bad, q)).toBeNull();
    }
  });
  it('invented amounts and currencies are refused (security review)', () => {
    expect(validateVelsRoute('{"intent":"owe","amount":"800","lender":"primo"}', ctx('le debo a mi primo un dinero, ¿lo anoto?'))).toBeNull();
    expect(validateVelsRoute('{"intent":"can_spend","amount":"1500.99"}', ctx('¿me alcanza para 1500?'))).toBeNull();
    expect(validateVelsRoute('{"intent":"can_spend","amount":"15"}', ctx('me pagan el 15, ¿me alcanza para la tele?'))).toBeNull();
    expect(validateVelsRoute('{"intent":"can_spend","amount":"500","currency":"USD"}', ctx('¿me alcanza para 500 soles?'))).toBeNull();
    expect(validateVelsRoute('{"intent":"can_spend","amount":"200"}', ctx('¿me alcanza para US$ 200?')))
      .toEqual({ kind: 'intent', intent: { k: 'can_spend', amountMinor: 20000, currency: 'USD' } });
    expect(validateVelsRoute('{"intent":"can_spend","amount":"2000"}', ctx('¿me alcanza para 2 lucas?')))
      .toEqual({ kind: 'intent', intent: { k: 'can_spend', amountMinor: 200000, currency: 'PEN' } });
  });
  it('a free reply may only repeat numbers already in the state or the question', () => {
    expect(validateVelsRoute('{"intent":"other","reply":"Tu alquiler de S/ 1,200 vence el 10."}', ctx('¿y lo del depa?'))).toEqual({ kind: 'reply', text: 'Tu alquiler de S/ 1,200 vence el 10.' });
    expect(validateVelsRoute('{"intent":"other","reply":"Podrías ahorrar S/ 640 al mes."}', ctx('¿cuánto puedo ahorrar?'))).toBeNull();
    expect(replyGrounded('Te quedan S/ 850.00', STATE, '')).toBe(true);
    expect(replyGrounded('Tienes mil soles libres hasta fin de mes.', STATE, '')).toBe(false);
    expect(replyGrounded('Te quedan quinientos soles.', STATE, '')).toBe(false);
  });
  it('amount parsing: decimals and thousands only, positive, bounded', () => {
    expect(amountToMinor('1,500.50')).toBe(150050);
    expect(amountToMinor('89.9')).toBe(8990);
    for (const v of ['0', 'abc', '12.345', '9999999999', 5]) expect(amountToMinor(v)).toBeNull();
  });
});

describe('Vels → Gemini → engine: the money comes from the engine', () => {
  const view: View = {
    today: '2026-10-08', obligations: [], debts: [], reviewCount: 0, suggestions: [],
    plans: [{ currency: 'PEN', base: { amountMinor: 240000, date: '2026-10-08', status: 'confirmed' }, freeMinor: 85000, reservedMinor: 155000, until: '2026-10-15', lines: [], missing: [] } as never],
  };
  it('Gemini says "free" (even with a made-up number in a reply field) → the answer carries the engine amount only', async () => {
    const f = fakeDb();
    const g0 = geminiModel({ models: stub('{"intent":"free","reply":"Tienes S/ 99,999 libres"}') });
    const q = '¿cuánto me sobra?';
    const r = await infer(f.db, { operation: 'assistant_answer', system: VELS_ROUTE_SYSTEM, schema: VELS_ROUTE_SCHEMA, messages: [{ role: 'user', content: q }] },
      (t) => validateVelsRoute(t, { state: compactView(view), question: q }) !== null, aiConfig({ GEMINI_API_KEY: 'k' }), g0);
    expect(r).toMatchObject({ ok: true, provider: 'gemini' });
    const route = validateVelsRoute((r as { text: string }).text, { state: compactView(view), question: q })!;
    if (route.kind !== 'intent') throw new Error('expected an intent');
    const a = answer(route.intent, view)!;
    expect(a.text).toContain('850');
    expect(a.text).not.toContain('99');
    expect(f.calls.map((c) => c.fn)).toEqual(['ai_reserve', 'ai_record']);
  });
  it('invalid Gemini output → recorded as invalid_output, never reaches the engine; API error → failed (Vels falls back)', async () => {
    const f = fakeDb();
    const bad = geminiModel({ models: stub('{"intent":"pay_everything"}') });
    expect(await infer(f.db, { operation: 'assistant_answer', system: 's', messages: [{ role: 'user', content: 'x' }] },
      (t) => validateVelsRoute(t, ctx('x')) !== null, aiConfig({ GEMINI_API_KEY: 'k' }), bad)).toEqual({ ok: false, reason: 'failed' });
    expect(f.calls.find((c) => c.fn === 'ai_record')?.args.p_outcome).toBe('invalid_output');
    const g = fakeDb();
    const down = geminiModel({ models: stub(() => { throw Object.assign(new Error('Internal'), { status: 500 }); }) });
    expect(await infer(g.db, { operation: 'assistant_answer', system: 's', messages: [{ role: 'user', content: 'x' }] },
      () => true, aiConfig({ GEMINI_API_KEY: 'k' }), down)).toEqual({ ok: false, reason: 'failed' });
  });
});
