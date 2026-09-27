# Runbook — database tests

`npm run test:db` creates a throwaway PostgreSQL cluster (>= 15), applies
`supabase/tests/local_supabase_shim.sql` (emulates Supabase roles, `auth.users`, `auth.uid()`) and every
file in `supabase/migrations/` in order, runs `tests/db/`, and deletes the cluster.

- Binaries auto-detected from `/usr/lib/postgresql/*/bin`; override with `PG_BIN=...`. Port: `PG_TEST_PORT` (default 54329).
- Runs as root by delegating to the `postgres` OS user.
- `npm test` excludes `tests/db` (DB suites also skip when `DATABASE_URL` is unset).
- The shim is LOCAL ONLY. Never apply it to a Supabase project.

Applying migrations to a real Supabase project is a separate, approved step (not done yet).
