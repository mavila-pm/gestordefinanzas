# Runbook — Supabase project and migrations

| Item | Value |
|---|---|
| Project | `gestordefinanzas` · ref `jeloegnvaxlfqjntbbyy` · us-east-1 · Postgres 17 · Free plan |
| Access | Supabase MCP connector authorized in the Claude Code web session (no keys in chat or repo) |
| Scope rule | Operate ONLY on ref `jeloegnvaxlfqjntbbyy`. The account also holds other projects (incl. production of another product): never touch them. |

## Applying a migration
1. Write `supabase/migrations/<timestamp>_<name>.sql`; `npm run test:db` must pass locally.
2. Product Owner approval for changes to the real project.
3. Apply the exact file content with `apply_migration` (name = file suffix). A migration whose SQL contains `DELETE` or `DROP`
   cannot go through the connector (it waits for a confirmation it cannot show and times out): the PO pastes it in the
   Supabase SQL Editor instead; then verify with a read-only query. Supabase records its own
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
| 20260928000018_ai_onboarding.sql | ai_onboarding | 2026-09-28 |
| 20260928000019_learning_decisions.sql | learning_decisions | 2026-09-28 |
| 20260928000020_planning_preferences.sql | planning_preferences | 2026-09-28 |
| 20260928000021_recurrence_lifecycle.sql | recurrence_lifecycle | 2026-09-28 |
| 20260928000022_review_queue_index.sql | review_queue_index | 2026-09-28 |
| 20260928000023_essentials_status.sql | essentials_status | 2026-09-28 |
| 20260929000024_idempotent_creates.sql | idempotent_creates | 2026-09-29 |
| 20260929000025_plan_applications.sql | plan_applications | 2026-09-29 |
| 20260929000026_card_statements.sql | card_statements | 2026-09-29 |
| 20260929000027_replay_hardening.sql | replay_hardening | 2026-09-29 |
| 20261007000028_delete_account.sql | **WITHDRAWN** — never applied; file removed (self-service deletion out of scope, 2026-10-08) | — |
| 20261008000029_registration.sql | registration | 2026-10-08 |
| 20261008000030_profiles_upsert_grant.sql | profiles_upsert_grant | 2026-10-08 |
| 20261008000031_password_step_trigger.sql | password_step_trigger | 2026-10-08 |
| 20261008000032_plan_auto_limits.sql | plan_auto_limits | 2026-10-08 |
| 20261008000033_login_throttle.sql | login_throttle | 2026-10-08 |
| 20261008000034_login_throttle_email_only.sql | login_throttle_email_only | 2026-10-08 |
| 20261008000035_login_throttle_purge.sql | **PENDING — PO applies it** (contains DELETE): Supabase → SQL Editor → paste the file → Run | — |
| 20261008000036_registration_peru_phone.sql | registration_peru_phone | 2026-10-08 |
| 20261008000037_unique_phone.sql | unique_phone (one number per account for every new write; trigger + advisory lock; function not callable by anon/authenticated; existing duplicates untouched) | 2026-10-08 |
| 20261010000038_savings_goal.sql | savings_goal (planning_settings.savings_goal_minor: explicit monthly goal, 1..1e11, own rows by existing RLS) | 2026-10-10 |
| 20261010000039_user_preferences.sql | user_preferences (Vels style/proactive, primary currency/account via composite FK, 4 notice toggles; own-row RLS, no delete grant) | 2026-10-10 |
| 20261010000040_cap_spent.sql | cap_spent + cap_spend() (Cap anti-bot single-use keys: SHA-256 hashes + expiry, no client grants on the table; function executable by anon/authenticated, invalid keys/TTL rejected; no DELETE, expired rows reused) | 2026-10-10 |
| 20261010000041_cap_spend_ttl.sql | cap_spend TTL bound 1..600 s (was 3600; the redeem token lives 10 min) | 2026-10-10 |
| 20261010000042_subscriptions.sql | fixed_expenses + provider (catalogue slug), card_id / account_id (composite FKs, at most one, set null on delete); subscriptions = obligations kind subscription | 2026-10-10 |
| 20261010000043_tour.sql | tour (user_preferences.tour_completed_at: first-use tour finished/skipped; null = pending or restarted; own-row RLS/grants unchanged) | 2026-10-11 |
| 20261011000044_balance_breakdown.sql | balance_snapshots + bank_minor / cash_minor (breakdown as said; parts ≥ 0; both present ⇒ sum = amount_minor); same RLS/grants | 2026-10-11 |
| 20261011000045_income_day_pending.sql | expected_incomes: a declared income may have its pay day por confirmar (day_of_month null; never projected); semimonthly needs both days or neither | 2026-10-11 |
| 20261012000046_billing_checkout.sql | billing_price() (Mensual 400 → 900 from 2027-01-01 Lima, Anual 5900, Vitalicio 19800, USD minor) + billing_orders (RLS read own; writes only via billing_create_order / billing_simulate_payment (demo only) / billing_activate (service_role)) + subscriptions.billing_plan | 2026-10-12 |
| 20261012000047_billing_hardening.sql | billing_create_order(plan, expected_minor) (price_changed; per-user advisory lock; supersedes pending orders) + billing_activate(order, provider, ref, amount, currency) (amount/currency/ref checked, 1 h TTL, re-checks subscription and trial at activation). Old signatures kept but EXECUTE revoked (no DROP) | 2026-10-12 |
| 20261020000048_bridge_allowance.sql | **PENDING — not applied** (branch wf/front-b-banks). assert_auto_allowance: per-person advisory lock inside the function (every automatic path: import RPC + Email Bridge), VOLATILE (fresh snapshot after the lock), 42501 `allowance_identity_mismatch` when request_uid() does not name the person; counting rules unchanged | — |
| 20261020000049_function_grants_registration_hardening.sql | **PENDING — not applied** (no DELETE/DROP: connector OK after PO approval; deploy the app first). Trigger functions not executable by clients (aborts if one still is); finish_registration replaces complete_registration (old kept, EXECUTE revoked): final once complete, phone_taken capped 5/account/24 h (registration_phone_refusals, deny-all). Verify: anon executes only cap_spend, login_attempt (query in `docs/security/rls.md`) | — |
| 20261020000050_fk_supporting_indexes.sql | **PENDING — not applied** (connector OK after PO approval). transaction_allocations_category (category delete no longer scans every person's splits); the other advisor FK INFOs are accepted with reasons in the file | — |
| 20261020000051_settlement_guard.sql | **PENDING — not applied** (ADR-0017; apply 051 → 052 → 053)** plan_settlements_guard trigger (confirmed only; payment = outgoing, not income, same currency; income = income, same currency). Before applying: a SELECT must return 0 violating rows (0 on 2026-10-20) | — |
| 20261020000052_partial_settlements.sql | **PENDING — not applied; PO applies it** (contains DROP CONSTRAINT status check + DROP INDEX plan_settlements_obligation_period; no DROP-free equivalent): status + 'partial', one closing row per (payment, month), advisory-locked guard (no skip over abonos, `period` in the trigger), plain FK index plan_settlements_obligation; debt_payments ledger + `record_debt_payment` (SECURITY DEFINER owned by app_writer, execute: authenticated). SQL Editor → paste → Run | — |
| 20261020000053_reserves.sql | **PENDING — not applied** Apartados: reserves + append-only reserve_entries (guard: never more out than saved, archived empty, linked movement same currency; max 50 active per person) + reserve_balances view (with `active`); own-row RLS, explicit grants; plain index per FK | — |

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
