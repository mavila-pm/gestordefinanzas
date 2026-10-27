import { afterEach, describe, expect, it, vi } from 'vitest';
import { culqiKeys, culqiPlans, culqiSales, culqiWebhook, planKey } from '../src/billing/config';

vi.mock('server-only', () => ({}));
vi.mock('../lib/server-db', () => ({ getServerPool: () => (process.env.DATABASE_URL ? ({ query: async () => ({ rows: [] }) }) : null) }));

/**
 * Test/live key guard and plan mapping (ADR-0019). Preview and Production share ONE database: sandbox keys only
 * outside Production (and only for demo accounts), live keys only in Production; every bad combination → disabled
 * with a reason, never "culqi". The order amount picks the Culqi plan, so the January 2027 monthly change (400 → 900)
 * can never subscribe anyone at a price they did not accept.
 */
const PK_T = 'pk_test_abcdef0123456789';
const SK_T = 'sk_test_abcdef0123456789';
const PK_L = 'pk_live_abcdef0123456789';
const SK_L = 'sk_live_abcdef0123456789';
const DB = 'postgres://x@127.0.0.1/db';
const base = (o: Record<string, string | undefined>) => ({ DATABASE_URL: DB, ...o });

describe('culqiKeys: the test/live matrix', () => {
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ['test keys on Preview', { CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_T, VERCEL_ENV: 'preview' }, 'test'],
    ['test keys locally', { CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_T }, 'test'],
    ['live keys in Production', { CULQI_PUBLIC_KEY: PK_L, CULQI_SECRET_KEY: SK_L, VERCEL_ENV: 'production' }, 'live'],
    ['live keys on Preview', { CULQI_PUBLIC_KEY: PK_L, CULQI_SECRET_KEY: SK_L, VERCEL_ENV: 'preview' }, 'live_key_outside_production'],
    ['live keys locally', { CULQI_PUBLIC_KEY: PK_L, CULQI_SECRET_KEY: SK_L }, 'live_key_outside_production'],
    ['test keys in Production', { CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_T, VERCEL_ENV: 'production' }, 'test_key_in_production'],
    ['pk_test + sk_live', { CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_L, VERCEL_ENV: 'production' }, 'key_mode_mismatch'],
    ['pk_live + sk_test', { CULQI_PUBLIC_KEY: PK_L, CULQI_SECRET_KEY: SK_T, VERCEL_ENV: 'preview' }, 'key_mode_mismatch'],
    ['keys swapped', { CULQI_PUBLIC_KEY: SK_T, CULQI_SECRET_KEY: PK_T }, 'bad_key_format'],
    ['truncated key', { CULQI_PUBLIC_KEY: 'pk_test_abc', CULQI_SECRET_KEY: SK_T }, 'bad_key_format'],
    ['key with junk', { CULQI_PUBLIC_KEY: `${PK_T}"<x>`, CULQI_SECRET_KEY: SK_T }, 'bad_key_format'],
    ['missing secret', { CULQI_PUBLIC_KEY: PK_T }, 'missing_keys'],
    ['missing both', {}, 'missing_keys'],
    ['no database', { CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_T, DATABASE_URL: undefined }, 'missing_database_url'],
  ];
  it.each(cases)('%s', (_name, env, want) => {
    const r = culqiKeys(base(env));
    if (want === 'test' || want === 'live') expect(r).toMatchObject({ ok: true, keys: { mode: want, livemode: want === 'live' } });
    else expect(r).toEqual({ ok: false, reason: want });
  });
});

describe('culqiSales / culqiWebhook', () => {
  const test = base({ CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_T, VERCEL_ENV: 'preview' });
  const live = base({ CULQI_PUBLIC_KEY: PK_L, CULQI_SECRET_KEY: SK_L, VERCEL_ENV: 'production' });
  it('new sales need CULQI_ENABLED=true exactly', () => {
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes']) expect(culqiSales({ ...test, CULQI_ENABLED: v }, true)).toEqual({ ok: false, reason: 'not_enabled' });
    expect(culqiSales({ ...test, CULQI_ENABLED: 'true' }, false)).toMatchObject({ ok: true });
  });
  it('LIVE sales also need Terms that cover charges (PO); the sandbox does not', () => {
    expect(culqiSales({ ...live, CULQI_ENABLED: 'true' }, false)).toEqual({ ok: false, reason: 'terms_without_billing' });
    expect(culqiSales({ ...live, CULQI_ENABLED: 'true' }, true)).toMatchObject({ ok: true, keys: { livemode: true } });
  });
  it('webhook: valid keys + Basic credentials (user ≤ 20, password ≥ 24); works with sales off', () => {
    const creds = { CULQI_WEBHOOK_USER: 'culqi-hook', CULQI_WEBHOOK_PASSWORD: 'p'.repeat(24) };
    expect(culqiWebhook({ ...test, ...creds, CULQI_ENABLED: 'false' })).toMatchObject({ ok: true, user: 'culqi-hook' });
    expect(culqiWebhook(test)).toEqual({ ok: false, reason: 'missing_webhook_credentials' });
    expect(culqiWebhook({ ...test, ...creds, CULQI_WEBHOOK_PASSWORD: 'short' })).toEqual({ ok: false, reason: 'weak_webhook_password' });
    expect(culqiWebhook({ ...test, ...creds, CULQI_WEBHOOK_USER: 'u'.repeat(21) })).toEqual({ ok: false, reason: 'weak_webhook_password' });
    expect(culqiWebhook({ ...live, ...creds, VERCEL_ENV: 'preview' })).toEqual({ ok: false, reason: 'live_key_outside_production' });
  });
});

describe('plans: one Culqi plan per (plan, amount, trial) — the 2027 monthly price guard', () => {
  const env = {
    CULQI_PLAN_MONTHLY_400_TRIAL: 'pln_test_M1o2N3t4H5l6Y7t8',
    CULQI_PLAN_MONTHLY_400: 'pln_test_M1o2N3t4H5l6Y7n8',
    CULQI_PLAN_ANNUAL_5900_TRIAL: 'pln_test_A1n2N3u4A5l6T7r8',
    CULQI_PLAN_ANNUAL_5900: ' pln_live_A1n2N3u4A5l6N7o8 ',
    CULQI_PLAN_MONTHLY: 'pln_test_Legacy0000000000',
    CULQI_PLAN_MONTHLY_0400: 'pln_test_Zero000000000000',
    CULQI_PLAN_MONTHLY_900: 'not-a-plan',
  };
  it('maps names to keys; wrong-mode, malformed and legacy names are left out and reported', () => {
    const { plans, issues } = culqiPlans(env, false);
    expect(plans).toEqual({ 'monthly:400:trial': 'pln_test_M1o2N3t4H5l6Y7t8', 'monthly:400:no_trial': 'pln_test_M1o2N3t4H5l6Y7n8', 'annual:5900:trial': 'pln_test_A1n2N3u4A5l6T7r8' });
    expect(issues.sort()).toEqual(['CULQI_PLAN_ANNUAL_5900:bad_plan_id', 'CULQI_PLAN_MONTHLY_900:bad_plan_id']);
  });
  it('purchasable: Vitalicio always; Mensual/Anual only with the exact plan for the amount the order will have', async () => {
    const { purchasable } = await import('../lib/billing');
    const mode = { kind: 'culqi' as const, livemode: false, publicKey: PK_T, plans: culqiPlans(env, false).plans };
    expect(purchasable(mode, 'lifetime', 19800, false)).toBe(true);
    expect(purchasable(mode, 'monthly', 400, true)).toBe(true);
    expect(purchasable(mode, 'monthly', 400, false)).toBe(true);
    // From 2027-01-01 (Lima) billing_price('monthly') is 900: without its own plans, monthly is off (fail closed).
    expect(purchasable(mode, 'monthly', 900, true)).toBe(false);
    expect(purchasable(mode, 'monthly', 900, false)).toBe(false);
    expect(purchasable(mode, 'annual', 5900, true)).toBe(true);
    expect(purchasable(mode, 'annual', 5900, false)).toBe(false);
    expect(purchasable({ kind: 'demo' }, 'monthly', 900, true)).toBe(true);
    expect(purchasable({ kind: 'disabled' }, 'lifetime', 19800, false)).toBe(false);
    expect(planKey('monthly', 900, false)).toBe('monthly:900:no_trial');
  });
});

describe('billingMode: who may buy with which keys', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const supabase = (demo: boolean) => ({ from: () => ({ select: () => ({ maybeSingle: async () => ({ data: demo ? { user_id: 'u' } : null }) }) }) });
  async function modeFor(env: Record<string, string>, demo: boolean) {
    for (const k of ['CULQI_PUBLIC_KEY', 'CULQI_SECRET_KEY', 'CULQI_ENABLED', 'VERCEL_ENV', 'DATABASE_URL']) vi.stubEnv(k, env[k] ?? '');
    const { billingMode } = await import('../lib/billing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return billingMode(supabase(demo) as any);
  }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const test = { CULQI_PUBLIC_KEY: PK_T, CULQI_SECRET_KEY: SK_T, CULQI_ENABLED: 'true', VERCEL_ENV: 'preview', DATABASE_URL: DB };
  const live = { CULQI_PUBLIC_KEY: PK_L, CULQI_SECRET_KEY: SK_L, CULQI_ENABLED: 'true', VERCEL_ENV: 'production', DATABASE_URL: DB };

  it('sandbox keys: demo accounts pay in Culqi test mode; real accounts cannot buy (a test charge never gives real Plus)', async () => {
    expect(await modeFor(test, true)).toMatchObject({ kind: 'culqi', livemode: false, publicKey: PK_T });
    expect(await modeFor(test, false)).toEqual({ kind: 'disabled' });
  });
  it('live keys: real accounts; demo accounts keep the simulation; live sales wait for the Terms (TERMS_COVER_BILLING)', async () => {
    const { TERMS_COVER_BILLING } = await import('../src/web/legal');
    expect(await modeFor(live, false)).toEqual(TERMS_COVER_BILLING ? expect.objectContaining({ kind: 'culqi', livemode: true }) : { kind: 'disabled' });
    expect(await modeFor(live, true)).toEqual({ kind: 'demo' });
  });
  it('culqiConfigured(): true only for CULQI_ENABLED=true with keys that pass the guard and a database', async () => {
    vi.stubEnv('DATABASE_URL', DB);
    const { culqiConfigured } = await import('../lib/billing');
    expect(culqiConfigured(test)).toBe(true);
    expect(culqiConfigured({ ...test, CULQI_ENABLED: 'false' })).toBe(false);
    expect(culqiConfigured({ ...test, CULQI_SECRET_KEY: SK_L })).toBe(false);
    expect(culqiConfigured({ ...live, VERCEL_ENV: 'preview' })).toBe(false);
  });
  it('switched off or misconfigured: demo simulates, real accounts see "disabled" — and the reason is logged once', async () => {
    expect(await modeFor({ ...test, CULQI_ENABLED: 'false' }, true)).toEqual({ kind: 'demo' });
    expect(await modeFor({ ...test, CULQI_ENABLED: 'false' }, false)).toEqual({ kind: 'disabled' });
    expect(await modeFor({ ...live, VERCEL_ENV: 'preview' }, false)).toEqual({ kind: 'disabled' });
    expect(await modeFor({ ...test, VERCEL_ENV: 'production' }, false)).toEqual({ kind: 'disabled' });
    const reasons = warn.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((e) => e.event === 'billing_disabled').map((e) => e.reason);
    expect(reasons).toEqual(expect.arrayContaining(['not_enabled', 'live_key_outside_production', 'test_key_in_production']));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SK_T);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SK_L);
  });
});
