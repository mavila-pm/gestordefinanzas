# Row Level Security model

Migrations: `supabase/migrations/`. Evidence: local `npm run test:db` (tests/db/rls.test.ts) and the RLS probe on the
real Supabase project (`docs/runbooks/supabase-migrations.md`). Supabase security advisors: 0 lints (2026-09-27).

| Table | anon | authenticated | service_role (server) |
|---|---|---|---|
| profiles, accounts, cards, merchant_rules | none | CRUD own rows (`user_id = auth.uid()`) | all |
| transactions | none | **read own only**; writes only via the functions below (TASK-004) | all |
| audit_events | none | read own only (append-only, written by the functions) | all |
| categories | none | read global + own; write own only | all |
| institutions | none | read | all |
| transaction_sources, financial_events | none | **read own only** (provenance is server-written) | all |

Defense in depth:
- Composite FKs `(id, user_id)`: a row can only reference the same user's account/card/transaction,
  even with a privileged connection.
- `unique (user_id, channel, external_event_id)` on transaction_sources: Level-1 idempotency under concurrency.
- No client role has TRUNCATE/REFERENCES/TRIGGER (TRUNCATE bypasses RLS); anon has no privilege at all. Tested.
- CHECKs: `amount_minor > 0`, type/direction consistency, `last4` exactly 4 digits (no PAN can be stored).
- Guard test: every table in `public` must have RLS enabled; a new table without RLS fails CI.
- Ingestion runs server-side and filters every query by `user_id` explicitly (`PgTransactionRepository`).

## Write path (TASK-004, ADR-0003) — closes the former accepted debt
Direct INSERT/UPDATE/DELETE on `transactions` is revoked from `authenticated`. Writes go through
`create_manual_transaction`, `review_transaction` and `correct_transaction` (SECURITY DEFINER, owned by `app_writer`:
NOLOGIN, no BYPASSRLS). `app_writer` has its own RLS policies bound to the caller's JWT, so RLS still applies inside
the functions; it has no DELETE/TRUNCATE and can only add `manual` provenance. Other users' rows answer `not_found`.
Evidence: `tests/db/secure-writes.test.ts` (A/B isolation, validation, audit, second barrier, financial rules).
Status on the real project: applied 2026-09-27 and verified by E2E 46/46 (`docs/runbooks/e2e.md`).
