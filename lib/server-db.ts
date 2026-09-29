import 'server-only';
import pg from 'pg';

let pool: pg.Pool | null | undefined;

/**
 * Privileged PostgreSQL pool for server-side ingestion ONLY (webhooks). Requires DATABASE_URL, a server-only secret.
 * Never imported by client components; every query through it must filter by user_id explicitly.
 */
export function getServerPool(): pg.Pool | null {
  if (pool !== undefined) return pool;
  const url = process.env.DATABASE_URL;
  pool = url ? new pg.Pool({ connectionString: url, max: 3 }) : null;
  return pool;
}
