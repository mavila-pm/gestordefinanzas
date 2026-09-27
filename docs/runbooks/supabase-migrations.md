# Runbook — Supabase project and migrations

| Item | Value |
|---|---|
| Project | `gestordefinanzas` · ref `jeloegnvaxlfqjntbbyy` · us-east-1 · Postgres 17 · Free plan |
| Access | Supabase MCP connector authorized in the Claude Code web session (no keys in chat or repo) |
| Scope rule | Operate ONLY on ref `jeloegnvaxlfqjntbbyy`. The account also holds other projects (incl. production of another product): never touch them. |

## Applying a migration
1. Write `supabase/migrations/<timestamp>_<name>.sql`; `npm run test:db` must pass locally.
2. Product Owner approval for changes to the real project.
3. Apply the exact file content with `apply_migration` (name = file suffix). Supabase records its own
   version timestamp; the mapping is below.
4. Verify: security advisors = 0 lints; RLS probe (below); performance advisors without WARN.

| Repo file | Applied on Supabase as | Date |
|---|---|---|
| 20260927000001_financial_core.sql | 20260927203511_financial_core | 2026-09-27 |
| 20260927000002_harden_rls_auto_enable.sql | 20260927203531_harden_rls_auto_enable | 2026-09-27 |
| 20260927000003_rls_performance.sql | applied as rls_performance | 2026-09-27 |

## RLS probe on the real project
A single `DO` block creates two probe users and data, acts as User A with `set local role authenticated`
+ `request.jwt.claims` (the PostgREST mechanism), records each result, and ends with `raise exception`
so everything is rolled back. Last result (2026-09-27): all 14 checks passed — A sees only own rows;
A cannot read/insert/update/delete/truncate B's data, link B's card, give rows to B or forge provenance;
anon denied; `ensure_rls` event trigger still enables RLS on new tables. Post-check: 0 probe users/rows left.

## Platform objects not created by us
- Event trigger `ensure_rls` → `public.rls_auto_enable()` (Supabase "automatic RLS"). Kept; EXECUTE revoked
  from public/anon/authenticated (migration 000002).
- Default privileges on new tables grant anon/authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN;
  migration 000001 revokes all and grants explicitly. Local shim mirrors this.
