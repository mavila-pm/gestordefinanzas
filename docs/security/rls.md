# Row Level Security model

Migrations: `supabase/migrations/`. Evidence: local `npm run test:db` (tests/db/rls.test.ts) and the RLS probe on the
real Supabase project (`docs/runbooks/supabase-migrations.md`). Supabase security advisors: 0 lints (2026-09-27).

| Table | anon | authenticated | service_role (server) |
|---|---|---|---|
| profiles, accounts, cards, merchant_rules, transactions | none | CRUD own rows (`user_id = auth.uid()`) | all |
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

Accepted debt (DEUDA ACEPTADA, fix before public beta): authenticated users can insert/update their own
transactions directly (Supabase client), including fields like `status`/`confidence`. Impact limited to the
user's own data. Resolution: route writes through server actions and narrow column grants (TASK with manual UI).
