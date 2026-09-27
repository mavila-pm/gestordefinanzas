import pg from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL;

export function makePool() {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
}

export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';

/**
 * Runs `fn` exactly like a Supabase client request: role `authenticated` (or `anon`) with the
 * JWT `sub` claim, inside a transaction that is always rolled back.
 */
export async function asRole<T>(
  pool: pg.Pool,
  role: 'authenticated' | 'anon',
  userId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(userId ? { sub: userId, role } : { role })]);
    return await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Error code of a failing statement, run in a savepoint so the transaction stays usable. */
export async function errorCode(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<string | null> {
  await c.query('savepoint s');
  try {
    await c.query(sql, params);
    await c.query('release savepoint s');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint s');
    return (e as { code?: string }).code ?? 'unknown';
  }
}
