import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { planState, renewalStillOpen, type SubscriptionRow } from '../../src/domain/entitlements';
import { DATABASE_URL, makePool, USER_A } from './helpers';

/**
 * ONE entitlement rule (ADR-0019): SQL billing_plan_state (used by ai_effective_plan → AI quota, automatic-movement
 * limits) and TS planState (used by every page) must give the same answer for the same row.
 */
const NOW = new Date('2026-11-15T12:00:00Z');
const d = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
type Row = Pick<SubscriptionRow, 'plan' | 'status' | 'trial_ends_at' | 'current_period_end' | 'billing_plan' | 'cancel_at_period_end'>;
const row = (o: Partial<Row>): Row => ({ plan: 'free', status: 'free', trial_ends_at: null, current_period_end: null, billing_plan: null, cancel_at_period_end: false, ...o });

const CASES: Array<[string, Row | null, 'free' | 'trial' | 'plus']> = [
  ['no row', null, 'free'],
  ['free row', row({}), 'free'],
  ['card-less trial, live', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(3) }), 'trial'],
  ['card-less trial, expired', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(-1) }), 'free'],
  ['paid trial, live', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(5), current_period_end: d(5), billing_plan: 'monthly' }), 'trial'],
  ['paid trial ended, first charge pending (grace)', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(-1), current_period_end: d(-1), billing_plan: 'monthly' }), 'plus'],
  ['paid trial ended beyond grace', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(-4), current_period_end: d(-4), billing_plan: 'annual' }), 'free'],
  ['paid trial cancelled, live', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(2), current_period_end: d(2), billing_plan: 'monthly', cancel_at_period_end: true }), 'trial'],
  ['paid trial cancelled, ended (no grace)', row({ plan: 'plus', status: 'trialing', trial_ends_at: d(-0.1), current_period_end: d(-0.1), billing_plan: 'monthly', cancel_at_period_end: true }), 'free'],
  ['monthly active in period', row({ plan: 'plus', status: 'active', current_period_end: d(10), billing_plan: 'monthly' }), 'plus'],
  ['monthly active, period ended, inside grace', row({ plan: 'plus', status: 'active', current_period_end: d(-2), billing_plan: 'monthly' }), 'plus'],
  ['monthly active, period + grace ended (lost renewal)', row({ plan: 'plus', status: 'active', current_period_end: d(-3.5), billing_plan: 'monthly' }), 'free'],
  ['recurring without a period end (fail closed)', row({ plan: 'plus', status: 'active', current_period_end: null, billing_plan: 'annual' }), 'free'],
  ['past_due inside grace', row({ plan: 'plus', status: 'past_due', current_period_end: d(-1), billing_plan: 'monthly' }), 'plus'],
  ['past_due after grace', row({ plan: 'plus', status: 'past_due', current_period_end: d(-5), billing_plan: 'monthly' }), 'free'],
  ['cancel at period end, before end', row({ plan: 'plus', status: 'active', current_period_end: d(20), billing_plan: 'annual', cancel_at_period_end: true }), 'plus'],
  ['cancel at period end, after end (no grace)', row({ plan: 'plus', status: 'active', current_period_end: d(-1), billing_plan: 'annual', cancel_at_period_end: true }), 'free'],
  ['lifetime', row({ plan: 'plus', status: 'active', billing_plan: 'lifetime' }), 'plus'],
  ['refunded lifetime', row({ plan: 'plus', status: 'canceled', billing_plan: 'lifetime' }), 'free'],
  ['manual Plus without end', row({ plan: 'plus', status: 'active' }), 'plus'],
  ['manual Plus ended', row({ plan: 'plus', status: 'active', current_period_end: d(-1) }), 'free'],
  ['manual past_due before end', row({ plan: 'plus', status: 'past_due', current_period_end: d(1) }), 'plus'],
  ['canceled', row({ plan: 'plus', status: 'canceled', current_period_end: d(10), billing_plan: 'monthly' }), 'free'],
  ['plan free but status active', row({ plan: 'free', status: 'active', billing_plan: 'monthly', current_period_end: d(10) }), 'free'],
];

describe.skipIf(!DATABASE_URL)('entitlement rule parity: SQL billing_plan_state ≡ TS planState', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });

  it(`${CASES.length} rows give the same answer in SQL and TS (and the expected one)`, async () => {
    for (const [name, r, expected] of CASES) {
      const sql = (await pool.query('select public.billing_plan_state($1, $2, $3, $4, $5, $6, $7, $8) as s',
        [r?.plan ?? null, r?.status ?? null, r?.billing_plan ?? null, r?.trial_ends_at ?? null, r?.current_period_end ?? null, r?.cancel_at_period_end ?? null, 3, NOW.toISOString()])).rows[0].s;
      expect({ name, sql }).toEqual({ name, sql: expected });
      expect({ name, ts: planState(r, 3, NOW) }).toEqual({ name, ts: expected });
    }
  });

  it('renewal still open: SQL billing_renewal_open ≡ TS renewalStillOpen', async () => {
    const rows: Array<[string | null, string | null, string | null, boolean | null]> = [];
    for (const plan of ['monthly', 'annual', 'lifetime', null]) for (const status of ['trialing', 'active', 'past_due', 'canceled', 'free', null])
      for (const ref of ['sxn_test_a1', null]) for (const cancel of [false, true, null]) rows.push([plan, status, ref, cancel]);
    for (const [plan, status, ref, cancel] of rows) {
      const sql = (await pool.query('select public.billing_renewal_open($1, $2, $3, $4) as o', [plan, status, ref, cancel])).rows[0].o;
      const ts = renewalStillOpen({ billing_plan: plan, status, provider_ref: ref, cancel_at_period_end: cancel });
      expect({ plan, status, ref, cancel, sql }).toEqual({ plan, status, ref, cancel, sql: ts });
    }
    expect(rows.filter(([p, s, r, c]) => renewalStillOpen({ billing_plan: p, status: s, provider_ref: r, cancel_at_period_end: c }))).toHaveLength(2 * 3 * 2);
  });

  it('ai_effective_plan uses the rule with plan_config.billing_grace_days (demo simulation first)', async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local')`, [USER_A]);
    const effective = async () => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
        await c.query('set local role app_writer');
        return (await c.query('select public.ai_effective_plan($1) as p', [USER_A])).rows[0].p as string;
      } finally { await c.query('rollback'); c.release(); }
    };
    expect(await effective()).toBe('free');
    await pool.query(`insert into public.subscriptions (user_id, plan, status, current_period_end, billing_plan) values ($1, 'plus', 'past_due', now() - interval '2 days', 'monthly')`, [USER_A]);
    expect(await effective()).toBe('plus');
    await pool.query(`update public.plan_config set value = 1 where key = 'billing_grace_days'`);
    try {
      expect(await effective()).toBe('free');
    } finally { await pool.query(`update public.plan_config set value = 3 where key = 'billing_grace_days'`); }
    await pool.query(`insert into public.demo_access (user_id, simulated_plan) values ($1, 'trial')`, [USER_A]);
    expect(await effective()).toBe('trial');
    await pool.query('delete from auth.users');
  });
});
