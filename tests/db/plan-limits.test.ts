import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorMessage, makePool, USER_A, USER_B } from './helpers';

/** Spec §81: Free = 50 automatic movements per Lima month and 1 institution for automation; Plus/trial uncapped. */
const INSERT = 'select public.import_insert_transaction($1::jsonb, $2::jsonb, null) as id';
const tx = (i: number, inst = 'BCP') => JSON.stringify({
  type: 'expense', direction: 'outflow', amount_minor: 1000 + i, currency: 'PEN', occurred_at: '2026-09-15T20:30:00-05:00',
  institution_code: inst, card_last4: null, merchant_raw: `TIENDA ${i}`, merchant_normalized: `TIENDA ${i}`,
  category: 'Otros', status: 'review_required', confidence: 'medium', fingerprint: `fp-${inst}-${i}`,
});
const src = (i: number, inst = 'BCP') => JSON.stringify({
  channel: 'import', external_event_id: `ev-${inst}-${i}`, parser_version: 'BCP_SMS_V1', template_verification: 'SYNTHETIC_UNVERIFIED', received_at: '2026-09-15T20:31:00Z',
});

describe.skipIf(!DATABASE_URL)('plan limits for automatic movements', () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = makePool(); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
    await pool.query(`update public.plan_config set value = 3 where key = 'free_auto_movements_per_month'`);
  });
  afterAll(async () => { await pool.query(`update public.plan_config set value = 50 where key = 'free_auto_movements_per_month'`); });

  it('Free: the (N+1)th automatic movement of the month is refused; manual entry and another person are unaffected', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      for (let i = 0; i < 3; i++) await c.query(INSERT, [tx(i), src(i)]);
      expect(await errorMessage(c, INSERT, [tx(3), src(3)])).toBe('plan_auto_limit');
      expect((await c.query(`select count(*)::int n from public.transactions`)).rows[0].n).toBe(3);
    });
    await asRole(pool, 'authenticated', USER_B, async (c) => { expect(await errorMessage(c, INSERT, [tx(9), src(9)])).toBeNull(); });
    // Movements created last month do not count.
    await pool.query(`update public.transactions set created_at = now() - interval '45 days' where user_id = $1`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => { expect(await errorMessage(c, INSERT, [tx(4), src(4)])).toBeNull(); });
  });

  it('Free: automation from a second institution is refused; the first one keeps working', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(INSERT, [tx(0, 'BCP'), src(0, 'BCP')]);
      expect(await errorMessage(c, INSERT, [tx(1, 'BBVA'), src(1, 'BBVA')])).toBe('plan_institution_limit');
      expect(await errorMessage(c, INSERT, [tx(2, 'BCP'), src(2, 'BCP')])).toBeNull();
    });
  });

  it('trial and Plus are not capped; the client cannot call the check or change the config', async () => {
    await pool.query(`insert into public.subscriptions (user_id, plan, status, trial_ends_at) values ($1, 'plus', 'trialing', now() + interval '7 days')`, [USER_A]);
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      for (let i = 0; i < 5; i++) expect(await errorMessage(c, INSERT, [tx(i, i % 2 ? 'BBVA' : 'BCP'), src(i, i % 2 ? 'BBVA' : 'BCP')])).toBeNull();
      expect(await errorMessage(c, `select public.assert_auto_allowance($1, 'BCP')`, [USER_B])).not.toBeNull();
    });
  });
});
