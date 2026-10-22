import { describe, expect, it } from 'vitest';
import {
  basicAuthOk, chargeBody, classifyError, culqiDate, culqiId, declineMessage, keyMode, parseCharge, parseCustomerList, parsePlan,
  parseRefund, parseSubscription, parseWebhook, WEBHOOK_MAX_BYTES,
} from '../src/billing/culqi';
import { CulqiClient, type FetchLike } from '../src/billing/culqi-client';
import fx from './fixtures/culqi/responses.synthetic.json';

/**
 * Culqi adapter (ADR-0018) against SYNTHETIC_UNVERIFIED fixtures and a mocked fetch: the real API is never called.
 * Every Culqi answer is untrusted input: fixed schemas, ids by pattern and mode, integer amounts.
 */
const SK = 'sk_test_0123456789abcdef';
const ORDER = '11111111-1111-4111-8111-111111111111';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function mockFetch(answers: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const a = answers.shift();
    if (!a || a === 'network') throw new Error('ECONNRESET');
    return { status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}
const logs: Array<Record<string, unknown>> = [];
const client = (answers: Parameters<typeof mockFetch>[0], sk = SK) => {
  const m = mockFetch(answers);
  return { c: new CulqiClient(sk, { fetch: m.fetch, log: (e) => logs.push(e), timeoutMs: 50 }), calls: m.calls };
};

describe('Culqi ids and keys', () => {
  it('ids carry kind and mode; anything else is not an id (never interpolated into a URL)', () => {
    expect(culqiId('chr_test_A1b2C3d4E5f6G7h8')).toEqual({ kind: 'chr', livemode: false });
    expect(culqiId('sxn_live_A1b2C3d4E5f6G7h8', 'sxn')).toEqual({ kind: 'sxn', livemode: true });
    for (const bad of ['chr_test_../../x', 'chr_A1b2C3d4E5f6', 'xyz_test_A1b2C3d4E5f6', 'chr_test_A1b2 C3d4', 'chr_test_', 42, null]) expect(culqiId(bad)).toBeNull();
    expect(culqiId('crd_test_A1b2C3d4E5f6G7h8', 'chr')).toBeNull();
  });
  it('key mode only when both keys are well formed and of the same mode', () => {
    expect(keyMode('pk_test_abcdef0123456789', 'sk_test_abcdef0123456789')).toBe('test');
    expect(keyMode('pk_live_abcdef0123456789', 'sk_live_abcdef0123456789')).toBe('live');
    expect(keyMode('pk_test_abcdef0123456789', 'sk_live_abcdef0123456789')).toBeNull();
    expect(keyMode('pk_test_abc', 'sk_test_abcdef0123456789')).toBeNull();
    expect(keyMode('sk_test_abcdef0123456789', 'pk_test_abcdef0123456789')).toBeNull();
    expect(() => new CulqiClient('pk_test_abcdef0123456789')).toThrow('culqi_bad_secret_key');
  });
  it('dates: epoch ms or seconds or ISO, sane range only', () => {
    expect(culqiDate(1792540800000)?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(culqiDate(1792540800)?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(culqiDate('2026-10-21T00:00:00Z')?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    for (const bad of [0, -1, '20/10/2026', 'tomorrow', null, 4102444800001, NaN]) expect(culqiDate(bad)).toBeNull();
  });
});

describe('Culqi response validators (fixed schemas)', () => {
  it('a paid charge: amount, currency, our order id from the metadata, mode from the id', () => {
    expect(parseCharge(fx.charge_ok)).toEqual({ id: 'chr_test_A1b2C3d4E5f6G7h8', amountMinor: 19800, currency: 'USD', succeeded: true, refundedMinor: 0, orderId: ORDER, subscriptionRef: null, livemode: false });
  });
  it('rejects a charge without outcome success, with a wrong currency, a non-integer amount or a malformed id', () => {
    expect(parseCharge({ ...clone(fx.charge_ok), outcome: undefined })?.succeeded).toBe(false);
    expect(parseCharge({ ...clone(fx.charge_ok), outcome: { type: 'venta_fallida' } })?.succeeded).toBe(false);
    expect(parseCharge({ ...clone(fx.charge_ok), capture: false })?.succeeded).toBe(false);
    expect(parseCharge({ ...clone(fx.charge_ok), currency_code: 'EUR' })).toBeNull();
    expect(parseCharge({ ...clone(fx.charge_ok), amount: 198.5 })).toBeNull();
    expect(parseCharge({ ...clone(fx.charge_ok), amount: '19800' })).toBeNull();
    expect(parseCharge({ ...clone(fx.charge_ok), id: 'chr_test_<script>' })).toBeNull();
    expect(parseCharge({ ...clone(fx.charge_ok), metadata: { order_id: 'not-a-uuid' } })?.orderId).toBeNull();
    expect(parseCharge('venta_exitosa')).toBeNull();
  });
  it('refund: same mode as its charge; plan: interval and free initial cycles; subscription: refs of its own mode', () => {
    expect(parseRefund(fx.refund_ok)).toEqual({ id: 'ref_test_R1e2F3u4N5d6O7k8', chargeRef: 'chr_test_A1b2C3d4E5f6G7h8', amountMinor: 19800, livemode: false });
    expect(parseRefund({ ...clone(fx.refund_ok), charge_id: 'chr_live_A1b2C3d4E5f6G7h8' })).toBeNull();
    expect(parsePlan(fx.plan_monthly_trial)).toMatchObject({ amountMinor: 400, currency: 'USD', interval: 'month', intervalCount: 1, freeInitialCycles: { count: 14, unit: 1 }, chargesAtStart: false });
    expect(parsePlan(fx.plan_monthly)).toMatchObject({ freeInitialCycles: null, chargesAtStart: true });
    expect(parsePlan({ ...clone(fx.plan_monthly), interval_unit_time: 9 })).toBeNull();
    const sub = parseSubscription({ ...clone(fx.subscription_trial), trial_end: 1792540800000, next_billing_date: 1792540800000, customer_id: 'cus_live_C1u2S3t4O5m6E7r8' });
    expect(sub).toMatchObject({ id: 'sxn_test_S1u2B3s4C5r6I7p8', planRef: 'pln_test_M1o2N3t4H5l6Y7t8', cardRef: 'crd_test_C1a2R3d4O5k6A7b8', customerRef: null, orderId: ORDER, rawStatus: 1 });
    expect(sub?.trialEnd?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  });
  it('customer lookup only on an exact email match', () => {
    const list = { data: [{ id: 'cus_test_Other0000000000', email: 'otra@example.test' }, { id: 'cus_test_C1u2S3t4O5m6E7r8', email: 'Persona@Example.test ' }] };
    expect(parseCustomerList(list, 'persona@example.test')).toEqual({ id: 'cus_test_C1u2S3t4O5m6E7r8' });
    expect(parseCustomerList(list, 'nadie@example.test')).toBeNull();
  });
  it('errors map to kinds that protect money; provider text is never shown (fixed Spanish copy)', () => {
    expect(classifyError(402, fx.charge_declined, true)).toEqual({ kind: 'declined', code: 'insufficient_funds' });
    expect(classifyError(400, { type: 'invalid_request_error', code: 'bad param!' }, true)).toEqual({ kind: 'invalid', code: 'invalid_request_error' });
    expect(classifyError(401, {}, true).kind).toBe('auth');
    expect(classifyError(500, {}, true).kind).toBe('unknown');
    expect(classifyError(500, {}, false).kind).toBe('unavailable');
    expect(classifyError(429, {}, true).kind).toBe('unavailable');
    expect(declineMessage('insufficient_funds')).toMatch(/saldo suficiente.*No se hizo ningún cargo/);
    expect(declineMessage('whatever')).not.toMatch(/fondos suficientes\.$/);
  });
  it('the charge body takes the amount from the server order only', () => {
    expect(chargeBody({ amountMinor: 19800, currency: 'USD', email: 'a@b.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'Velsuno Plus Vitalicio', orderId: ORDER }))
      .toEqual({ amount: 19800, currency_code: 'USD', email: 'a@b.pe', source_id: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'Velsuno Plus Vitalicio', capture: true, metadata: { order_id: ORDER } });
  });
});

describe('Culqi webhook parsing and Basic auth', () => {
  it('reads only the type and the object id (data as object or JSON string); event id or digest as idempotency key', () => {
    const raw = JSON.stringify({ ...fx.webhook_charge_succeeded, data: JSON.stringify(fx.charge_ok) });
    expect(parseWebhook(raw)).toEqual({ eventRef: 'evt_test_E1v2E3n4T5o6K7a8', type: 'charge.creation.succeeded', objectRef: 'chr_test_A1b2C3d4E5f6G7h8', objectKind: 'chr', livemode: false });
    const noId = JSON.stringify({ type: 'charge.creation.succeeded', data: fx.charge_ok });
    expect(parseWebhook(noId)?.eventRef).toMatch(/^sha256:[0-9a-f]{48}$/);
    expect(parseWebhook(noId)?.eventRef).toBe(parseWebhook(noId)?.eventRef);
    for (const bad of ['', 'nope', '[]', '{"type":"DROP TABLE"}', JSON.stringify({ type: 'charge.creation.succeeded', data: '{bad' })]) expect(parseWebhook(bad)).toBeNull();
    expect(parseWebhook(JSON.stringify({ type: 'charge.creation.succeeded', data: { id: '../../admin' } }))?.objectRef).toBeNull();
    expect(WEBHOOK_MAX_BYTES).toBe(65536);
  });
  it('Basic credentials compared in constant time; anything else is refused', () => {
    const h = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    const pw = 'x'.repeat(30);
    expect(basicAuthOk(h('culqi', pw), 'culqi', pw)).toBe(true);
    expect(basicAuthOk(h('culqi', `${pw}y`), 'culqi', pw)).toBe(false);
    expect(basicAuthOk(h('otro', pw), 'culqi', pw)).toBe(false);
    expect(basicAuthOk(`Bearer ${pw}`, 'culqi', pw)).toBe(false);
    expect(basicAuthOk(null, 'culqi', pw)).toBe(false);
    expect(basicAuthOk('Basic !!!', 'culqi', pw)).toBe(false);
  });
});

describe('CulqiClient over a mocked fetch (never the real API)', () => {
  it('POST /v2/charges with the Bearer secret key, the order amount and our order id; no retry', async () => {
    const { c, calls } = client([{ status: 201, body: fx.charge_ok }]);
    const r = await c.charge({ amountMinor: 19800, currency: 'USD', email: 'persona@example.test', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'Velsuno Plus Vitalicio', orderId: ORDER });
    expect(r.ok && r.value.succeeded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.culqi.com/v2/charges', method: 'POST' });
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${SK}`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount: 19800, currency_code: 'USD', metadata: { order_id: ORDER } });
  });
  it('a network cut or a 5xx on a charge is UNKNOWN (maybe charged) and is not retried; on a read it is unavailable', async () => {
    const a = client(['network', { status: 201, body: fx.charge_ok }]);
    const r = await a.c.charge({ amountMinor: 19800, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER });
    expect(r).toMatchObject({ ok: false, kind: 'unknown' });
    expect(a.calls).toHaveLength(1);
    const b = client([{ status: 502, body: 'bad gateway' }]);
    expect(await b.c.charge({ amountMinor: 19800, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER })).toMatchObject({ ok: false, kind: 'unknown' });
    const g = client(['network']);
    expect(await g.c.getCharge('chr_test_A1b2C3d4E5f6G7h8')).toMatchObject({ ok: false, kind: 'unavailable' });
    // A 2xx we cannot read on a money call: unknown, never "failed".
    const u = client([{ status: 201, body: '<html>' }]);
    expect(await u.c.charge({ amountMinor: 19800, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER })).toMatchObject({ ok: false, kind: 'unknown', code: 'unreadable_response' });
  });
  it('a timeout aborts the request (10 s in production) and counts as unknown for a charge', async () => {
    const slow: FetchLike = (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const c = new CulqiClient(SK, { fetch: slow, timeoutMs: 20, log: () => {} });
    expect(await c.charge({ amountMinor: 1, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER })).toMatchObject({ ok: false, kind: 'unknown', code: 'network' });
  });
  it('declines, 3-D Secure and a live object on test keys are refused', async () => {
    expect(await client([{ status: 402, body: fx.charge_declined }]).c.charge({ amountMinor: 19800, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER }))
      .toMatchObject({ ok: false, kind: 'declined', code: 'insufficient_funds' });
    expect(await client([{ status: 200, body: fx.charge_3ds }]).c.charge({ amountMinor: 19800, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER }))
      .toMatchObject({ ok: false, kind: 'needs_authentication' });
    const live = { ...clone(fx.charge_ok), id: 'chr_live_A1b2C3d4E5f6G7h8' };
    expect(await client([{ status: 200, body: live }]).c.getCharge('chr_test_A1b2C3d4E5f6G7h8')).toMatchObject({ ok: false, code: 'mode_mismatch' });
  });
  it('bad ids, tokens of the other mode or a non-positive amount never reach the network', async () => {
    const { c, calls } = client([]);
    expect(await c.getCharge('chr_live_A1b2C3d4E5f6G7h8')).toMatchObject({ ok: false, code: 'bad_id' });
    expect(await c.getSubscription('sxn_test_../x')).toMatchObject({ ok: false, code: 'bad_id' });
    expect(await c.charge({ amountMinor: 0, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_test_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER })).toMatchObject({ ok: false, code: 'bad_amount' });
    expect(await c.charge({ amountMinor: 1, currency: 'USD', email: 'x@y.pe', sourceRef: 'tkn_live_Z9y8X7w6V5u4T3s2', description: 'd', orderId: ORDER })).toMatchObject({ ok: false, code: 'bad_source' });
    expect(await c.refund({ chargeRef: 'chr_test_A1b2C3d4E5f6G7h8', amountMinor: 1.5 })).toMatchObject({ ok: false, code: 'bad_refund' });
    expect(calls).toHaveLength(0);
  });
  it('recurrent endpoints and bodies (CONFIRMED paths, culqi-php)', async () => {
    const sub = { ...clone(fx.subscription_trial), trial_end: 1792540800000, next_billing_date: 1792540800000 };
    const { c, calls } = client([{ status: 200, body: fx.plan_monthly_trial }, { status: 201, body: sub }, { status: 200, body: { id: sub.id, deleted: true } }, { status: 201, body: fx.card_ok }, { status: 201, body: fx.refund_ok }]);
    expect((await c.getPlan('pln_test_M1o2N3t4H5l6Y7t8')).ok).toBe(true);
    expect((await c.createSubscription({ cardRef: 'crd_test_C1a2R3d4O5k6A7b8', planRef: 'pln_test_M1o2N3t4H5l6Y7t8', orderId: ORDER })).ok).toBe(true);
    expect(await c.cancelSubscription('sxn_test_S1u2B3s4C5r6I7p8')).toEqual({ ok: true, value: { deleted: true } });
    expect((await c.createCard({ customerRef: 'cus_test_C1u2S3t4O5m6E7r8', tokenRef: 'tkn_test_Z9y8X7w6V5u4T3s2' })).ok).toBe(true);
    expect((await c.refund({ chargeRef: 'chr_test_A1b2C3d4E5f6G7h8', amountMinor: 19800 })).ok).toBe(true);
    expect(calls.map((x) => `${x.method} ${x.url.replace('https://api.culqi.com/v2', '')}`)).toEqual([
      'GET /recurrent/plans/pln_test_M1o2N3t4H5l6Y7t8', 'POST /recurrent/subscriptions/create', 'DELETE /recurrent/subscriptions/sxn_test_S1u2B3s4C5r6I7p8',
      'POST /cards', 'POST /refunds',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ card_id: 'crd_test_C1a2R3d4O5k6A7b8', plan_id: 'pln_test_M1o2N3t4H5l6Y7t8', tyc: true, metadata: { order_id: ORDER } });
    expect(JSON.parse(calls[4]!.body!)).toEqual({ amount: 19800, charge_id: 'chr_test_A1b2C3d4E5f6G7h8', reason: 'solicitud_comprador' });
  });
  it('logs carry operation, status and a short code: never the key, email, token or provider messages', () => {
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(5);
    for (const secret of [SK, 'persona@example.test', 'x@y.pe', 'tkn_test_Z9y8X7w6V5u4T3s2', 'fondos', 'autorizada']) expect(text).not.toContain(secret);
    for (const l of logs) expect(Object.keys(l).sort()).toEqual(['code', 'event', 'op', 'status']);
  });
});
