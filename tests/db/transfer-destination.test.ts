import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

/** Transfer / withdrawal destination (migration 060, ADR-0020): own account, same currency, withdrawal → cash. */
describe.skipIf(!DATABASE_URL)('transfer destination', () => {
  let pool: pg.Pool;
  const acc = async (user: string, kind: 'bank' | 'cash', currency = 'PEN', alias = kind === 'cash' ? 'Efectivo' : 'Ahorros') =>
    (await pool.query(`insert into public.accounts (user_id, kind, alias, currency) values ($1, $2, $3, $4) returning id`, [user, kind, alias, currency])).rows[0].id as string;
  const tx = async (user: string, type: string, direction: string, account: string | null, currency = 'PEN') => (await pool.query(`insert into public.transactions
    (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, status, confidence, fingerprint, account_id)
    values ($1, now(), $2, $3, 20000, $4, 'ATM', 'confirmed', 'high', 'fp', $5) returning id, counterparty_account_id`, [user, type, direction, currency, account])).rows[0] as { id: string; counterparty_account_id: string | null };
  const set = 'select public.set_transaction_counterparty($1, $2)';

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('an ATM withdrawal goes to the cash pocket of its currency; none → stays null (asked)', async () => {
    const bank = await acc(USER_A, 'bank');
    expect((await tx(USER_A, 'withdrawal', 'outflow', bank)).counterparty_account_id).toBeNull();
    const cash = await acc(USER_A, 'cash');
    expect((await tx(USER_A, 'withdrawal', 'outflow', bank)).counterparty_account_id).toBe(cash);
    expect((await tx(USER_A, 'withdrawal', 'outflow', null, 'USD')).counterparty_account_id).toBeNull(); // no USD cash
    expect((await tx(USER_A, 'expense', 'outflow', bank)).counterparty_account_id).toBeNull();
    // An imported withdrawal that names no source account gets no destination (+cash alone would create money).
    expect((await tx(USER_A, 'withdrawal', 'outflow', null)).counterparty_account_id).toBeNull();
  });

  it('a correction of currency, source or type clears a destination that no longer fits', async () => {
    const a = await acc(USER_A, 'bank'); const b = await acc(USER_A, 'bank', 'PEN', 'Sueldo'); const cash = await acc(USER_A, 'cash');
    const t = (await tx(USER_A, 'internal_transfer', 'neutral', a)).id;
    const dest = async () => (await pool.query('select counterparty_account_id from public.transactions where id = $1', [t])).rows[0].counterparty_account_id;
    await pool.query('update public.transactions set counterparty_account_id = $2 where id = $1', [t, b]);
    await pool.query(`update public.transactions set currency = 'USD' where id = $1`, [t]);
    expect(await dest()).toBeNull();
    await pool.query(`update public.transactions set currency = 'PEN', counterparty_account_id = $2 where id = $1`, [t, b]);
    await pool.query('update public.transactions set account_id = $2 where id = $1', [t, b]); // the source becomes the destination
    expect(await dest()).toBeNull();
    await pool.query('update public.transactions set account_id = $2, counterparty_account_id = $3 where id = $1', [t, a, b]);
    await pool.query(`update public.transactions set type = 'withdrawal', direction = 'outflow' where id = $1`, [t]); // a bank is no cash
    expect(await dest()).toBeNull();
    await pool.query('update public.transactions set counterparty_account_id = $2 where id = $1', [t, cash]);
    await pool.query(`update public.transactions set type = 'withdrawal' where id = $1`, [t]);
    expect(await dest()).toBe(cash);
  });

  it('"¿A qué cuenta fue?": own, active, same currency, not the source; a withdrawal only to cash; null clears', async () => {
    const a = await acc(USER_A, 'bank'); const b = await acc(USER_A, 'bank', 'PEN', 'Sueldo'); const usd = await acc(USER_A, 'bank', 'USD', 'Dólares');
    const cash = await acc(USER_A, 'cash'); const foreign = await acc(USER_B, 'bank');
    const t = (await tx(USER_A, 'internal_transfer', 'neutral', a)).id;
    const w = (await pool.query(`update public.transactions set counterparty_account_id = null where id = $1 returning id`, [(await tx(USER_A, 'withdrawal', 'outflow', a)).id])).rows[0].id;
    const e = (await tx(USER_A, 'expense', 'outflow', a)).id;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, set, [t, b])).toBeNull();
      expect((await c.query('select counterparty_account_id from public.transactions where id = $1', [t])).rows[0].counterparty_account_id).toBe(b);
      expect(await errorMessage(c, set, [t, usd])).toBe('invalid_account_currency');
      expect(await errorMessage(c, set, [t, a])).toBe('same_account');
      expect(await errorMessage(c, set, [t, foreign])).toBe('invalid_account');
      expect(await errorMessage(c, set, [w, b])).toBe('withdrawal_needs_cash');
      expect(await errorMessage(c, set, [w, cash])).toBeNull();
      expect(await errorMessage(c, set, [e, b])).toBe('counterparty_not_applicable');
      expect(await errorMessage(c, set, [t, null])).toBeNull();
      // Each change is audited like a correction.
      expect((await c.query(`select count(*)::int n from public.audit_events where transaction_id = $1 and changes ? 'counterparty_account_id'`, [t])).rows[0].n).toBe(2);
    });
    const noSource = (await tx(USER_A, 'internal_transfer', 'neutral', null)).id;
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect(await errorMessage(c, set, [noSource, b])).toBe('source_required');
    });
    await asRole(pool, 'authenticated', USER_B, async (c) => {
      expect(await errorMessage(c, set, [t, foreign])).toBe('not_found');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, set, [t, b])).toBe('42501');
    });
  });

  it('a movement corrected to another type loses its destination', async () => {
    const a = await acc(USER_A, 'bank'); const b = await acc(USER_A, 'bank', 'PEN', 'Sueldo');
    const t = (await tx(USER_A, 'internal_transfer', 'neutral', a)).id;
    await pool.query('update public.transactions set counterparty_account_id = $2 where id = $1', [t, b]);
    await pool.query(`update public.transactions set type = 'expense', direction = 'outflow' where id = $1`, [t]);
    expect((await pool.query('select counterparty_account_id from public.transactions where id = $1', [t])).rows[0].counterparty_account_id).toBeNull();
  });
});
