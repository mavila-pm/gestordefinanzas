import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { DATABASE_URL, makePool } from './helpers';

/** scripts/qa/demo-account.sql: one synthetic user with ~6 months of history; insert-only, own namespace. */
describe.skipIf(!DATABASE_URL)('demo account seed', () => {
  let pool: pg.Pool;
  const seed = (run: string) => readFileSync('scripts/qa/demo-account.sql', 'utf8').replaceAll('__DEMO_PASSWORD__', 'pw-test-only-1').replaceAll('__DEMO_RUN__', run);
  const count = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].n as number;

  beforeAll(async () => {
    pool = makePool();
    await pool.query(`
      create schema if not exists extensions;
      create or replace function extensions.gen_salt(text) returns text language sql as 'select public.gen_salt($1)';
      create or replace function extensions.crypt(text, text) returns text language sql as 'select public.crypt($1, $2)';
      alter table auth.users add column if not exists instance_id uuid, add column if not exists aud text, add column if not exists role text,
        add column if not exists encrypted_password text, add column if not exists email_confirmed_at timestamptz,
        add column if not exists raw_app_meta_data jsonb, add column if not exists raw_user_meta_data jsonb,
        add column if not exists created_at timestamptz, add column if not exists updated_at timestamptz,
        add column if not exists confirmation_token text, add column if not exists recovery_token text, add column if not exists email_change_token_new text,
        add column if not exists email_change text, add column if not exists email_change_token_current text, add column if not exists phone_change text,
        add column if not exists phone_change_token text, add column if not exists reauthentication_token text;
      create table if not exists auth.identities (provider_id text, user_id uuid references auth.users (id) on delete cascade, identity_data jsonb,
        provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);`);
  });
  afterAll(async () => { await pool?.end(); });

  it('creates one demo user with months of varied history, twice without collisions', async () => {
    await pool.query(seed('demorun0001'));
    await pool.query(seed('demorun0002'));
    const u = (await pool.query(`select id from auth.users where email = 'demo-demorun0001@gestordefinanzas.invalid'`)).rows[0].id as string;
    expect(await count(`select count(*)::int n from public.transactions where user_id = $1`, [u])).toBeGreaterThan(100);
    expect(await count(`select count(distinct date_trunc('month', occurred_at))::int n from public.transactions where user_id = $1`, [u])).toBeGreaterThanOrEqual(5);
    expect(await count(`select count(distinct type)::int n from public.transactions where user_id = $1`, [u])).toBeGreaterThanOrEqual(9);
    expect(await count(`select count(*)::int n from public.transactions where user_id = $1 and status <> 'confirmed'`, [u])).toBe(3);
    expect(await count(`select count(*)::int n from public.transactions where user_id = $1 and occurred_at > now()`, [u])).toBe(0);
    for (const t of ['fixed_expenses', 'debts', 'expected_incomes', 'cards', 'card_statements', 'accounts', 'budgets', 'balance_snapshots', 'transaction_sources'])
      expect(await count(`select count(*)::int n from public.${t} where user_id = $1`, [u]), t).toBeGreaterThan(0);
    expect(await count(`select count(*)::int n from public.debts where user_id = $1 and installments_paid <= coalesce(installments_total, 0) and installment_minor is not null`, [u])).toBe(1);
  });
  it('refuses a run id or email outside the demo namespace', async () => {
    await expect(pool.query(seed('BAD RUN'))).rejects.toThrow(/invalid run id/);
  });
});
