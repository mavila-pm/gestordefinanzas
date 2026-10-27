import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asRole, DATABASE_URL, errorCode, errorMessage, makePool, USER_A, USER_B } from './helpers';

/**
 * Money sources (migration 057, ADR-0020): debit cards with their accounts, cash, credit "used" checkpoints.
 * Own rows only, append-only checkpoints, PEN ≠ USD, one cash pocket per currency, a debit purchase resolves to the
 * ONE account of its currency, never stored: full number (last4 only) or long digit runs in names.
 */
describe.skipIf(!DATABASE_URL)('money sources', () => {
  let pool: pg.Pool;
  const save = `select public.save_money_source($1, $2::jsonb, $3::uuid, $4::jsonb) r`;
  const debit = { alias: 'Débito BCP', kind: 'debit', institution: 'BCP', currency: 'PEN', last4: '1234', color: 'blue', expiry_month: 8, expiry_year: 2029 };
  const tx = (c: pg.Pool, user: string, card: string | null, currency = 'PEN', account: string | null = null) => c.query(`insert into public.transactions
    (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, status, confidence, fingerprint, card_id, account_id)
    values ($1, now(), 'expense', 'outflow', 4000, $2, 'TAMBO', 'confirmed', 'high', 'fp', $3, $4) returning account_id`, [user, currency, card, account]);

  beforeAll(() => { pool = makePool(); });
  beforeEach(async () => {
    await pool.query('delete from auth.users');
    await pool.query(`insert into auth.users (id, email) values ($1, 'a@test.local'), ($2, 'b@test.local')`, [USER_A, USER_B]);
  });
  afterAll(async () => { await pool?.end(); });

  it('a debit card with two accounts is one atomic write, idempotent per reference', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const accounts = [{ alias: 'Ahorros Soles', currency: 'PEN', balance_minor: 150000 }, { alias: 'Cuenta dólares', currency: 'USD', balance_minor: 30000 }];
      const r1 = (await c.query(save, ['ref-debit-0001', JSON.stringify(debit), null, JSON.stringify(accounts)])).rows[0].r;
      expect(r1.account_ids).toHaveLength(2);
      expect(r1.replay).toBe(false);
      const r2 = (await c.query(save, ['ref-debit-0001', JSON.stringify(debit), null, JSON.stringify(accounts)])).rows[0].r;
      expect(r2).toMatchObject({ card_id: r1.card_id, account_ids: r1.account_ids, replay: true });
      const rows = (await c.query(`select a.alias, a.currency, a.kind, a.institution_code, k.amount_minor, k.source
        from public.accounts a join public.account_balance_checkpoints k on k.account_id = a.id order by a.alias`)).rows;
      expect(rows).toEqual([
        { alias: 'Ahorros Soles', currency: 'PEN', kind: 'bank', institution_code: 'BCP', amount_minor: '150000', source: 'opening' },
        { alias: 'Cuenta dólares', currency: 'USD', kind: 'bank', institution_code: 'BCP', amount_minor: '30000', source: 'opening' },
      ]);
      expect((await c.query('select count(*)::int n from public.card_accounts')).rows[0].n).toBe(2);
      // "Agregar otra cuenta" later, to the same card.
      const r3 = (await c.query(save, ['ref-debit-0002', null, r1.card_id, JSON.stringify([{ alias: 'Sueldo', currency: 'PEN', balance_minor: null }])])).rows[0].r;
      expect(r3.account_ids).toHaveLength(1);
      expect((await c.query('select count(*)::int n from public.account_balance_checkpoints')).rows[0].n).toBe(2); // unknown balance → no checkpoint, never 0
    });
  });

  it('a failure halfway writes nothing (bad currency in the second account)', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const accounts = [{ alias: 'Ahorros', currency: 'PEN', balance_minor: 100 }, { alias: 'Euros', currency: 'EUR', balance_minor: 100 }];
      expect(await errorCode(c, save, ['ref-debit-0003', JSON.stringify(debit), null, JSON.stringify(accounts)])).toBe('22P02');
      expect((await c.query('select count(*)::int n from public.cards')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int n from public.accounts')).rows[0].n).toBe(0);
    });
  });

  it('a credit card keeps its line, cycle, colour, expiry and the line used today; it takes no accounts', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const credit = { alias: 'Visa Oro', kind: 'credit', bank_name: 'Caja Arequipa', currency: 'USD', last4: '9876', color: 'black',
        expiry_month: 12, expiry_year: 2028, credit_limit_minor: 500000, statement_day: 20, payment_day: 5, used_minor: 120000 };
      const r = (await c.query(save, ['ref-credit-001', JSON.stringify(credit), null, '[]'])).rows[0].r;
      expect((await c.query('select bank_name, institution_code, color, expiry_month, expiry_year, credit_limit_minor from public.cards where id = $1', [r.card_id])).rows[0])
        .toEqual({ bank_name: 'Caja Arequipa', institution_code: null, color: 'black', expiry_month: 12, expiry_year: 2028, credit_limit_minor: '500000' });
      expect((await c.query('select used_minor, currency, source from public.card_used_checkpoints')).rows).toEqual([{ used_minor: '120000', currency: 'USD', source: 'opening' }]);
      expect(await errorMessage(c, save, ['ref-credit-002', null, r.card_id, JSON.stringify([{ alias: 'X', currency: 'USD' }])])).toBe('accounts_need_debit_card');
      // A "used" checkpoint in another currency is refused (PEN ≠ USD).
      expect(await errorCode(c, `insert into public.card_used_checkpoints (user_id, card_id, currency, used_minor, source) values ($1, $2, 'PEN', 1, 'adjustment')`, [USER_A, r.card_id])).toBe('23514');
    });
  });

  it('refuses what must never be stored or cannot be true', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const bad = (o: object, ref: string) => errorCode(c, save, [ref, JSON.stringify({ ...debit, ...o }), null, '[]']);
      expect(await bad({ last4: '12345' }, 'ref-bad-00001')).toBe('23514'); // full number: last 4 only
      expect(await bad({ alias: 'Tarjeta 4557880012345678' }, 'ref-bad-00002')).toBe('23514');
      expect(await bad({ color: 'pink' }, 'ref-bad-00003')).toBe('23514');
      expect(await bad({ expiry_month: 13 }, 'ref-bad-00004')).toBe('23514');
      expect(await bad({ expiry_month: 5, expiry_year: null }, 'ref-bad-00005')).toBe('23514');
      expect(await bad({ institution: 'BCP', bank_name: 'Otro banco' }, 'ref-bad-00006')).toBe('23514');
      expect(await bad({ institution: '', bank_name: '12345678 banco' }, 'ref-bad-00007')).toBe('23514');
      // Separators do not hide a card number (direct API calls skip the app's checks).
      expect(await bad({ alias: '4111 1111 1111 1111' }, 'ref-bad-00008')).toBe('23514');
      expect(await bad({ alias: '4111-1111-1111-1111' }, 'ref-bad-00009')).toBe('23514');
      expect(await errorCode(c, save, ['ref-bad-00010', JSON.stringify(debit), null, JSON.stringify([{ alias: '4111 1111 1111 1111', currency: 'PEN' }])])).toBe('23514');
      // Cash is a plain pocket: no bank, no digits.
      expect(await errorCode(c, `insert into public.accounts (user_id, kind, alias, currency, last4) values ($1, 'cash', 'Efectivo', 'PEN', '1111')`, [USER_A])).toBe('23514');
    });
  });

  it('cash: one pocket per currency, a new checkpoint each time, never negative, PEN apart from USD', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const cash = 'select public.set_cash_balance($1::public.currency_code, $2, $3) id';
      const a = (await c.query(cash, ['PEN', 15000, 'cash-ref-0001'])).rows[0].id;
      const b = (await c.query(cash, ['PEN', 12000, 'cash-ref-0002'])).rows[0].id;
      expect(b).toBe(a);
      expect((await c.query(cash, ['PEN', 12000, 'cash-ref-0002'])).rows[0].id).toBe(a); // replay
      const usd = (await c.query(cash, ['USD', 2000, 'cash-ref-0003'])).rows[0].id;
      expect(usd).not.toBe(a);
      expect((await c.query(`select amount_minor, source from public.account_balance_checkpoints where account_id = $1 order by created_at, source desc`, [a])).rows)
        .toEqual([{ amount_minor: '15000', source: 'opening' }, { amount_minor: '12000', source: 'adjustment' }]);
      expect(await errorMessage(c, cash, ['PEN', -1, 'cash-ref-0004'])).toBe('invalid_amount');
      expect(await errorCode(c, `insert into public.accounts (user_id, kind, alias, currency) values ($1, 'cash', 'Otro efectivo', 'PEN')`, [USER_A])).toBe('23505');
      expect(await errorCode(c, `insert into public.account_balance_checkpoints (user_id, account_id, currency, amount_minor, source) values ($1, $2, 'PEN', -5, 'adjustment')`, [USER_A, a])).toBe('23514');
      expect(await errorCode(c, `insert into public.account_balance_checkpoints (user_id, account_id, currency, amount_minor, source) values ($1, $2, 'USD', 5, 'adjustment')`, [USER_A, a])).toBe('23514');
    });
  });

  it('an account with balances keeps its currency; a debit card with accounts stays debit', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      const r = (await c.query(save, ['ref-ident-0001', JSON.stringify(debit), null, JSON.stringify([{ alias: 'Ahorros', currency: 'PEN', balance_minor: 100 }])])).rows[0].r;
      expect(await errorCode(c, `update public.accounts set currency = 'USD' where id = $1`, [r.account_ids[0]])).toBe('23514');
      expect(await errorCode(c, `update public.cards set kind = 'credit' where id = $1`, [r.card_id])).toBe('23514');
      expect(await errorCode(c, `update public.cards set alias = 'Débito nuevo' where id = $1`, [r.card_id])).toBeNull();
    });
  });

  it('checkpoints are append-only for the person', async () => {
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query('select public.set_cash_balance($1::public.currency_code, $2, $3)', ['PEN', 100, 'cash-ref-0010']);
      expect(await errorCode(c, 'update public.account_balance_checkpoints set amount_minor = 1')).toBe('42501');
      expect(await errorCode(c, 'delete from public.account_balance_checkpoints')).toBe('42501');
      expect(await errorCode(c, 'update public.card_used_checkpoints set used_minor = 1')).toBe('42501');
    });
  });

  it('a debit purchase resolves to the ONE account of its currency; two candidates or another currency stay null', async () => {
    const r = (await asRole(pool, 'authenticated', USER_A, async (c) => {
      const out = (await c.query(save, ['ref-debit-0100', JSON.stringify(debit), null,
        JSON.stringify([{ alias: 'Ahorros', currency: 'PEN', balance_minor: 1000 }])])).rows[0].r;
      await c.query('commit');
      await c.query('begin');
      return out;
    }));
    // asRole rolls back its own transaction; the committed write above stays.
    const card = r.card_id as string;
    const acc = (r.account_ids as string[])[0];
    expect((await tx(pool, USER_A, card, 'PEN')).rows[0].account_id).toBe(acc);
    expect((await tx(pool, USER_A, card, 'USD')).rows[0].account_id).toBeNull();
    expect((await tx(pool, USER_A, card, 'PEN', null)).rows[0].account_id).toBe(acc);
    // A second soles account on the same card: ambiguous → the person picks, never guessed.
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      await c.query(save, ['ref-debit-0101', null, card, JSON.stringify([{ alias: 'Sueldo', currency: 'PEN' }])]);
      await c.query('commit');
      await c.query('begin');
    });
    expect((await tx(pool, USER_A, card, 'PEN')).rows[0].account_id).toBeNull();
  });

  it('A never sees nor links B rows', async () => {
    const r = await asRole(pool, 'authenticated', USER_B, async (c) => {
      const out = (await c.query(save, ['ref-debit-0200', JSON.stringify(debit), null, JSON.stringify([{ alias: 'B', currency: 'PEN', balance_minor: 5 }])])).rows[0].r;
      await c.query('commit');
      await c.query('begin');
      return out;
    });
    await asRole(pool, 'authenticated', USER_A, async (c) => {
      expect((await c.query('select count(*)::int n from public.account_balance_checkpoints')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int n from public.card_accounts')).rows[0].n).toBe(0);
      expect(await errorMessage(c, save, ['ref-steal-001', null, r.card_id, JSON.stringify([{ alias: 'X', currency: 'PEN' }])])).toBe('not_found');
      expect(await errorCode(c, `insert into public.account_balance_checkpoints (user_id, account_id, currency, amount_minor, source) values ($1, $2, 'PEN', 5, 'adjustment')`,
        [USER_A, r.account_ids[0]])).toBe('23503');
      expect(await errorCode(c, `insert into public.card_accounts (user_id, card_id, account_id) values ($1, $2, $3)`, [USER_B, r.card_id, r.account_ids[0]])).toBe('42501');
    });
    await asRole(pool, 'anon', null, async (c) => {
      expect(await errorCode(c, 'select * from public.account_balance_checkpoints')).toBe('42501');
      expect(await errorCode(c, `select public.set_cash_balance('PEN', 1, 'cash-ref-anon1')`)).toBe('42501');
    });
  });
});
