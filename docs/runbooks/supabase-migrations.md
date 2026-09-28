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
| 20260927000004_secure_transaction_writes.sql | 20260927215130_secure_transaction_writes (approved by Mauro) | 2026-09-27 |
| 20260928000005_accounts_rules_learning.sql | accounts_rules_learning (autonomous phase; checked complete: owners app_writer, old correct_transaction dropped, CREATE revoked, app_writer DELETE only on transactions) | 2026-09-27 |
| 20260928000006_import_channel.sql | import_channel | 2026-09-27 |
| 20260928000007_import_write_path.sql | import_write_path (import functions owned by app_writer; writer inserts only manual/import sources and import events) | 2026-09-27 |
| 20260928000008_email_bridge.sql | email_bridge (checked: RLS everywhere, deliveries ledger server-only, rotate owned by app_writer) | 2026-09-27 |
| 20260928000009_budgets.sql | budgets | 2026-09-27 |
| 20260928000010_commitments.sql | commitments | 2026-09-27 |
| 20260928000011_plans_entitlements.sql | plans_entitlements | 2026-09-27 |
| 20260928000012_reported_values.sql | reported_values | 2026-09-27 |
| 20260928000013_card_auto_link.sql | card_auto_link | 2026-09-28 |
| 20260928000014_transaction_allocations.sql | transaction_allocations | 2026-09-28 |
| 20260928000015_split_stale_errcode.sql | split_stale_errcode | 2026-09-28 |
| 20260928000016_profile_names.sql | profile_names | 2026-09-28 |
| 20260928000017_cashflow_planning.sql | cashflow_planning | 2026-09-28 |

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

## Post-check of 000004 (2026-09-27)
- Complete, not partial: 9 functions present; the 3 write functions are SECURITY DEFINER owned by `app_writer`
  (NOLOGIN, no BYPASSRLS, no CREATEROLE); temporary CREATE on `public` revoked; `authenticated` has only SELECT on
  `transactions` and `audit_events`; no TRUNCATE/REFERENCES/TRIGGER for anon/authenticated/app_writer; anon has no
  table privilege; every public table has RLS.
- Security advisors: only `0029 authenticated_security_definer_function_executable` ×3 (WARN) for the three
  write functions — intended (ADR-0003). Performance advisors: INFO only (pre-existing institution FKs, unused
  indexes on an empty database).

## Advisors after 000009 (2026-09-27)
- WARN 0029 ×8: the audited SECURITY DEFINER write functions (ADR-0003) — intended.
- INFO 0008: `inbound_deliveries` has RLS and no policy — intended (server-only ledger, no client grants).
- WARN leaked password protection disabled — Auth setting for the PO (may require a paid plan).
