import type pg from 'pg';

/** Create an order as the user and COMMIT it (asRole always rolls back). */
export async function orderFor(pool: pg.Pool, user: string, plan: string): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    const id = (await c.query('select public.billing_create_order($1, public.billing_price($1)) as id', [plan])).rows[0].id as string;
    await c.query('commit');
    return id;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally { c.release(); }
}

/** Server step before calling the provider (privileged connection, like lib/billing-store.ts). */
export async function beginCharge(pool: pg.Pool, order: string, user: string, livemode = true) {
  return (await pool.query('select * from public.billing_begin_charge($1, $2, $3, $4)', [order, user, 'culqi', livemode])).rows[0] as
    { plan_code: string; amount_minor: string; currency: string; trial_days: number };
}

export const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** Mensual/Anual activation with the provider's dates (defaults: a 14-day trial whose first charge is its end). */
export async function activateSub(pool: pg.Pool, order: string, o: { sub?: string; trialEnd?: string | null; periodEnd?: string; amount?: number; currency?: string; livemode?: boolean } = {}) {
  const trialEnd = o.trialEnd === undefined ? days(14) : o.trialEnd;
  return (await pool.query(
    `select public.billing_activate_subscription($1, 'culqi', $2, 'cus_test_a1', 'crd_test_a1',
       coalesce($3::bigint, (select amount_minor from public.billing_orders where id = $1)), $4, $5, $6, $7) as s`,
    [order, o.sub ?? 'sxn_test_a1', o.amount ?? null, o.currency ?? 'USD', trialEnd, o.periodEnd ?? trialEnd ?? days(30), o.livemode ?? true])).rows[0].s as string;
}

export async function effectivePlan(pool: pg.Pool, user: string): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await c.query('set local role app_writer');
    return (await c.query('select public.ai_effective_plan($1) as p', [user])).rows[0].p as string;
  } finally { await c.query('rollback'); c.release(); }
}

/** Test-only reset: the ledger is append-only (trigger), so the cleanup lifts the trigger as the table owner. */
export async function resetBilling(pool: pg.Pool) {
  await pool.query('alter table public.billing_events disable trigger billing_events_append_only');
  try {
    await pool.query('delete from public.billing_events');
  } finally {
    await pool.query('alter table public.billing_events enable trigger billing_events_append_only');
  }
  await pool.query('delete from auth.users');
  await pool.query(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000000a', 'a@test.local'), ('00000000-0000-4000-8000-00000000000b', 'b@test.local')`);
}
