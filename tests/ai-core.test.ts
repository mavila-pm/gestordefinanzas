import { describe, expect, it } from 'vitest';
import { domainWrites } from '../src/ai/apply';
import { answer, detectIntent, type View } from '../src/ai/assistant';
import { aiAvailability, aiConfig, providerFor } from '../src/ai/config';
import { mergePatches } from '../src/ai/draft';
import { aiPlanFrom, allowance } from '../src/ai/entitlements';
import { checkImage, sniff, stripJpeg, stripPng } from '../src/ai/image';
import { interpret } from '../src/ai/interpreter';
import { estimateCostMicroUsd, ratesFrom } from '../src/ai/pricing';
import { geminiProvider } from '../src/ai/providers/gemini';
import { openAICompatibleProvider } from '../src/ai/providers/openai-compatible';
import { minor, validateInterpretation, validateVision } from '../src/ai/schema';
import { emptyDraft } from '../src/ai/types';
import { proposalFrom } from '../src/ai/vision';
import { buildPlan } from '../src/engine/planning';

const req = { operation: 'onboarding_extract' as const, model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hola' }], json: true, maxOutputTokens: 100, reasoning: 'off' as const, timeoutMs: 1000 };
const fakeFetch = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) => (async (url: string, init: RequestInit) => {
  if (seen) { seen.url = url; seen.init = init; }
  return new Response(JSON.stringify(body), { status });
}) as unknown as typeof fetch;

describe('provider adapters (§26, §32): usage exactly as the provider reports it', () => {
  it('OpenAI-compatible (DeepSeek): JSON mode, cache hits, images as data URLs, no key in the body', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const p = openAICompatibleProvider({ name: 'deepseek', baseUrl: 'https://x.test/', apiKey: 'k', visionModels: ['v'], fetchImpl: fakeFetch(200, {
      choices: [{ message: { content: '{"patches":[]}' } }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100 }, model: 'm-1' }, seen) });
    const r = await p.complete(req);
    expect(r.usage).toEqual({ input: 120, output: 30, cached: 100, image: 0 });
    expect(seen.url).toBe('https://x.test/chat/completions');
    const body = JSON.parse(String(seen.init!.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(String(seen.init!.body)).not.toContain('"k"');
    await expect(p.complete({ ...req, images: [{ mime: 'image/png', base64: 'AA' }] })).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('Gemini: thinking tokens count as output, image tokens split from text, errors are typed', async () => {
    const p = geminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{}' }] } }],
      usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 20, thoughtsTokenCount: 5, promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 258 }] } }) });
    expect((await p.complete(req)).usage).toEqual({ input: 142, output: 25, cached: 0, image: 258 });
    await expect(geminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(503, {}) }).complete(req)).rejects.toMatchObject({ kind: 'http', retryable: true });
    await expect(geminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(400, {}) }).complete(req)).rejects.toMatchObject({ kind: 'http', retryable: false });
    await expect(geminiProvider({ apiKey: 'k', fetchImpl: fakeFetch(429, {}) }).complete(req)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('config: default is no provider; no key → no provider; fixture never on production', () => {
    expect(aiConfig({}).provider).toBe('none');
    expect(aiAvailability({})).toEqual({ text: false, vision: false });
    expect(providerFor('deepseek', {})).toBeNull();
    expect(providerFor('gemini', { GEMINI_API_KEY: 'x' })?.name).toBe('gemini');
    expect(aiConfig({ AI_PROVIDER: 'fixture', AI_ALLOW_FIXTURE: '1', VERCEL_ENV: 'production' }).provider).toBe('none');
    expect(aiConfig({ AI_PROVIDER: 'fixture', AI_ALLOW_FIXTURE: '1' }).provider).toBe('fixture');
    expect(aiConfig({ AI_MAX_OUTPUT_ASSISTANT_ANSWER: '999999' }).maxOutput.assistant_answer).toBe(300);
  });

  it('cost estimate: cached input at the cached rate; unknown models at the most expensive rate (fail safe)', () => {
    const rates = ratesFrom({ AI_PRICES: '{"cheap":{"in":100000,"out":400000,"cached":10000},"bad":{"in":-1}}' });
    expect(estimateCostMicroUsd('cheap', { input: 1_000_000, output: 1_000_000, cached: 500_000, image: 0 }, rates)).toBe(50_000 + 5_000 + 400_000);
    expect(rates.bad).toBeUndefined();
    expect(estimateCostMicroUsd('unknown-model', { input: 1000, output: 0, cached: 0, image: 0 }, rates)).toBeGreaterThan(0);
  });
});

describe('provider output is untrusted (§58)', () => {
  it('keeps only valid fields; amounts become integer minor units; garbage is rejected', () => {
    expect(minor('284.30')).toBe(28430);
    expect(minor(5700)).toBe(570000);
    expect(minor('-5')).toBeUndefined();
    expect(minor('1e9')).toBeUndefined();
    const r = validateInterpretation('texto {"patches":[{"t":"income","amount":"5700","day":5,"evil":"x"},{"t":"obligation","kind":"hack","name":"Luz","amount":"12.5"},{"t":"nope"}],"bare":null}');
    expect(r?.patches).toEqual([{ t: 'income', amountMinor: 570000, day: 5 }, { t: 'obligation', kind: 'other', name: 'Luz', amountMinor: 1250 }]);
    expect(validateInterpretation('no json')).toBeNull();
    expect(validateInterpretation('{"patches":"x"}')).toBeNull();
  });

  it('vision contract: dates, last4 only, confidence; empty reads are low confidence', () => {
    const v = validateVision('{"document":"card_statement","institution":"bcp","last4":"4821","currency":"PEN","balance":"2430","payment_minimum":"284.30","due_date":"2026-10-19","confidence":"high","uncertain":[]}')!;
    expect(v).toMatchObject({ document: 'card_statement', institution: 'BCP', last4: '4821', balanceMinor: 243000, paymentMinimumMinor: 28430, dueDate: '2026-10-19' });
    expect(validateVision('{"document":"card_statement","last4":"4557880012344821"}')!.last4).toBeNull();
    expect(validateVision('{"document":"other"}')!.confidence).toBe('low');
    const p = proposalFrom(v)!;
    expect(p.title).toBe('Tarjeta BCP •••• 4821');
    expect(p.rows.map((r) => r.label)).toEqual(['Deuda', 'Pago mínimo', 'Vence']);
    expect(p.patches[0]).toMatchObject({ t: 'debt', kind: 'card', balanceMinor: 243000, minimumMinor: 28430, dueDay: 19 });
    expect(proposalFrom({ ...v, uncertain: ['payment_minimum'] })!.rows.find((r) => r.label === 'Pago mínimo')!.doubtful).toBe(true);
  });
});

describe('image intake (§57)', () => {
  const png = (w: number, h: number, extra: number[] = []) => {
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 2, 0, 0, 0]), ...extra, ...chunk('IEND', [])]);
  };
  it('sniffs the real type, bounds dimensions, strips metadata; the filename/declared type are irrelevant', () => {
    const text = [0, 0, 0, 5, ...[...'tEXt'].map((c) => c.charCodeAt(0)), 65, 66, 67, 68, 69, 0, 0, 0, 0];
    const img = png(800, 600, text);
    const ok = checkImage(img);
    expect(ok).toMatchObject({ ok: true, mime: 'image/png', width: 800, height: 600 });
    expect((ok as { bytes: Uint8Array }).bytes.length).toBe(img.length - text.length);
    expect(stripPng(png(800, 600)).length).toBe(png(800, 600).length);
    expect(checkImage(png(100, 100))).toEqual({ ok: false, error: 'too_small' });
    expect(checkImage(png(9000, 600))).toEqual({ ok: false, error: 'too_big_dimensions' });
    expect(checkImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toEqual({ ok: false, error: 'unsupported' });
    expect(checkImage(new Uint8Array())).toEqual({ ok: false, error: 'empty' });
    expect(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    // JPEG: APP1 (EXIF/GPS) dropped, SOS data kept.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 6, 69, 120, 105, 102, 0xff, 0xda, 0, 2, 1, 2, 3]);
    expect([...stripJpeg(jpeg)]).toEqual([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2, 3]);
  });
});

describe('assistant: deterministic intents first (§54-§55)', () => {
  const plan = buildPlan({ currency: 'PEN', today: '2026-09-28', base: { kind: 'balance', amountMinor: 300000, asOf: '2026-09-28T10:00:00Z', stale: false },
    obligations: [{ id: 'o1', source: 'obligation', name: 'Alquiler', kind: 'rent', currency: 'PEN', amountMinor: 150000, amountStatus: 'confirmed', frequency: 'monthly', anchorMonth: null, dueDay: 1, dueDayMax: null, targetDay: null, since: '2026-09-15' }],
    settledObligations: new Map(), incomes: [{ id: 'i1', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 5, dayMax: null, secondDay: null, anchorDate: null }],
    settledIncomes: new Map(), essentialsMonthlyMinor: 0, cushionMinor: 0 });
  const view: View = { today: '2026-09-28', plans: [plan], obligations: [{ id: 'o1', name: 'Alquiler', currency: 'PEN', amountMinor: 150000 }], debts: [], reviewCount: 2, suggestions: [] };

  it('routes common questions without a provider and answers with engine numbers', () => {
    expect(detectIntent('¿Puedo gastar S/ 500?')).toEqual({ k: 'can_spend', amountMinor: 50000, currency: 'PEN' });
    expect(detectIntent('cuánto puedo gastar')).toEqual({ k: 'free' });
    expect(detectIntent('qué tengo que pagar')).toEqual({ k: 'upcoming', range: 'next' });
    expect(detectIntent('qué viene esta semana')).toEqual({ k: 'upcoming', range: 'week' });
    expect(detectIntent('ya me pagaron')).toEqual({ k: 'got_paid' });
    expect(detectIntent('el internet ahora cuesta S/160')).toEqual({ k: 'update_amount', name: 'internet', amountMinor: 16000 });
    expect(detectIntent('muéstrame por qué tengo solo S/ 850 libres')).toEqual({ k: 'why_free' });
    expect(detectIntent('me quedé misio antes de fin de mes')).toEqual({ k: 'unknown' });
    const free = answer({ k: 'free' }, view)!;
    expect(free.text).toBe(`Tienes S/ 1,500 libres hasta el 4 oct.`);
    expect(answer({ k: 'can_spend', amountMinor: 200000, currency: 'PEN' }, view)!.text).toContain('te faltarían S/ 500');
    expect(answer({ k: 'upcoming', range: 'next' }, view)!.rows).toEqual([{ label: 'Alquiler', value: 'S/ 1,500 · 1 oct' }]);
    expect(answer({ k: 'update_amount', name: 'alquiler', amountMinor: 160000 }, view)!.actions![0]).toMatchObject({ type: 'act', act: 'patch_obligation', fields: { id: 'o1', amount: '1600.00' } });
    expect(answer({ k: 'unknown' }, view)).toBeNull();
  });
  it('"ya me pagaron" offers to link a matching deposit (confirmation, never automatic); otherwise asks the balance', () => {
    const m = { incomeId: 'i1', name: 'Sueldo', period: '2026-09', expectedDate: '2026-09-25', transactionId: 't1', receivedMinor: 570000, currency: 'PEN' as const, expectedMinor: 570000, confidence: 'high' as const };
    const a = answer({ k: 'got_paid' }, { ...view, incomeMatches: [m] })!;
    expect(a.text).toContain('¿Es tu sueldo del 25 set?');
    expect(a.actions![0]).toMatchObject({ type: 'act', act: 'link_income', fields: { incomeId: 'i1', transactionId: 't1', period: '2026-09' } });
    expect(answer({ k: 'got_paid' }, view)!.pending).toBe('balance');
    const amb = { ...m, ambiguous: true, candidates: [{ incomeId: 'a', name: 'Bono A', period: '2026-09', expectedDate: '2026-09-25' }, { incomeId: 'b', name: 'Bono B', period: '2026-09', expectedDate: '2026-09-25' }] };
    const pick = answer({ k: 'got_paid' }, { ...view, incomeMatches: [amb] })!;
    expect(pick.text).toBe('Vi un ingreso de S/ 5,700. ¿Cuál es?');
    expect(pick.actions!.map((x) => (x as { fields: Record<string, string> }).fields.incomeId)).toEqual(['a', 'b']);
  });
  it('what-if questions are simulated by the engine (nothing written) and answered in one line', () => {
    expect(detectIntent('¿qué pasa si pago S/ 1,000 a la tarjeta?')).toEqual({ k: 'what_pay_debt', amountMinor: 100000, target: 'tarjeta' });
    expect(detectIntent('¿y si mi sueldo se retrasa 5 días?')).toEqual({ k: 'what_delay', days: 5 });
    expect(detectIntent('Retraso de 7 días')).toEqual({ k: 'what_delay', days: 7 });
    expect(detectIntent('y si me pagan tarde? se demora el sueldo')).toEqual({ k: 'what_delay', days: null });
    expect(detectIntent('¿y si la luz sube a S/ 200?')).toEqual({ k: 'what_bill', name: 'luz', amountMinor: 20000 });
    expect(detectIntent('¿puedo gastar S/ 500?')).toMatchObject({ k: 'can_spend' });
    const input = { currency: 'PEN' as const, today: '2026-09-28', base: { kind: 'balance' as const, amountMinor: 500000, asOf: '2026-09-28', stale: false },
      obligations: [], settledObligations: new Map(), incomes: [{ id: 'i', name: 'Sueldo', currency: 'PEN' as const, amountMinor: 400000, amountStatus: 'confirmed' as const, frequency: 'monthly' as const, dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null }],
      settledIncomes: new Map(), essentialsMonthlyMinor: 0, cushionMinor: 0 };
    const v2 = { ...view, inputs: { PEN: input }, debtLinks: [{ id: 'd', name: 'Tarjeta BCP', currency: 'PEN' as const, balanceMinor: 300000, annualRateBp: 6000, obligationId: null }] };
    const a = answer({ k: 'what_pay_debt', amountMinor: 100000, target: 'tarjeta' }, v2)!;
    expect(a.text).toBe('Si pagas S/ 1,000 a Tarjeta BCP: te quedan S/ 4,000 libres (antes S/ 5,000).');
    expect(a.rows).toEqual([{ label: 'Deuda después', value: 'S/ 2,000' }, { label: 'Interés que evitas', value: '~S/ 50 al mes' }]);
    expect(answer({ k: 'what_delay', days: null }, v2)!.text).toBe('¿Cuántos días se retrasaría?');
    expect(answer({ k: 'what_pay_debt', amountMinor: 100000, target: 'deuda' }, { ...v2, debtLinks: [] })!.text).toBe('No tengo deudas registradas.');
  });
  it('a stated preference is confirmed before saving, with its trade-off; it can be reverted', () => {
    expect(detectIntent('No me importa quedarme en cero este mes si pago deuda')).toEqual({ k: 'pref_zero_debt', on: true });
    expect(detectIntent('mejor no, quiero guardar algo')).toEqual({ k: 'pref_zero_debt', on: false });
    const a = answer({ k: 'pref_zero_debt', on: true }, view)!;
    expect(a.text).toMatch(/^Entendido: si pagas deuda, puedes quedarte en cero\..*¿Lo guardo\?$/);
    expect(a.actions![0]).toMatchObject({ act: 'set_pref', fields: { key: 'allow_zero_for_debt', value: 'on' } });
  });
  it('asks for the missing data instead of guessing (§66)', () => {
    const noBase = { ...view, plans: [{ ...plan, base: null, freeMinor: null, missing: [{ code: 'balance' as const, text: 'Indica cuánto tienes hoy en tu cuenta.' }] }] };
    const a = answer({ k: 'can_spend', amountMinor: 1000, currency: 'PEN' }, noBase)!;
    expect(a.text).toContain('necesito indica cuánto tienes hoy'.slice(0, 9));
    expect(a.pending).toBe('balance');
  });
});

describe('onboarding → domain rows (§67), plan display (§48)', () => {
  it('writes planner rows; unknown stays unknown; unknown debt balance is deferred, never 0', () => {
    const i = interpret('Me pagan 5,700 el 5, uso BCP, pago el carro como el 10, debo en la tarjeta y le debo plata a mi pareja. Alquiler 1200 el 1. Tengo 3,000 en la cuenta. Comida 500 al mes');
    const d = mergePatches(emptyDraft(), i.patches, i.bare).draft;
    const w = domainWrites(d, 'u1');
    expect(w.incomes).toEqual([expect.objectContaining({ amount_minor: 570000, amount_status: 'confirmed', frequency: 'monthly', day_of_month: 5 })]);
    expect(w.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Carro', amount_minor: null, amount_status: 'unknown', due_day: 10 }),
      expect.objectContaining({ name: 'Alquiler', amount_minor: 120000, due_day: 1 }),
    ]));
    expect(w.debts).toEqual([]);
    expect(w.deferred).toEqual(expect.arrayContaining(['Tarjeta BCP: falta el saldo', 'Deuda con tu pareja: falta el saldo']));
    expect(w.accounts).toEqual([{ user_id: 'u1', institution_code: 'BCP', alias: 'BCP', currency: 'PEN' }]);
    expect(w.balance).toEqual({ user_id: 'u1', currency: 'PEN', amount_minor: 300000 });
    expect(w.settings).toEqual({ user_id: 'u1', currency: 'PEN', essentials_monthly_minor: 50000 });
  });

  it('usage is shown as a bar and a count, from plan_config, per plan; demo simulation is labelled', () => {
    const cfg = { ai_free_monthly_tokens: 25000, ai_free_monthly_camera_reads: 2, ai_plus_monthly_tokens: 1500000, ai_plus_monthly_camera_reads: 50, ai_onboarding_tokens: 80000, ai_onboarding_camera_reads: 3 };
    const now = new Date('2026-09-28T12:00:00Z');
    const rows = [{ bucket: 'm:2026-09', weighted_tokens: '25000', camera_reads: 1 }];
    expect(allowance('free', false, cfg, rows, false, now)).toMatchObject({ reached: true, camera: { used: 1, limit: 2 }, conversation: { ratio: 1 } });
    expect(allowance('plus', true, cfg, rows, false, now)).toMatchObject({ reached: false, simulated: true, camera: { used: 1, limit: 50 } });
    expect(aiPlanFrom({ plan: 'plus', status: 'active', trial_ends_at: null, current_period_end: null }, 'free', now)).toBe('free');
    expect(aiPlanFrom({ plan: 'plus', status: 'trialing', trial_ends_at: '2026-10-01T00:00:00Z', current_period_end: null }, null, now)).toBe('trial');
    expect(aiPlanFrom(null, null, now)).toBe('free');
  });
});
