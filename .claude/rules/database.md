---
paths:
  - "supabase/**"
  - "tests/db/**"
  - "scripts/test-db.sh"
  - "src/infrastructure/**"
---
# Database rules
- Never edit an applied migration: add a new `supabase/migrations/<timestamp>_<name>.sql`. Applied list: `docs/runbooks/supabase-migrations.md`.
- Every new table: RLS on, own-row policy `(select auth.uid())`, `unique (id, user_id)` + composite `(x_id, user_id)` FKs,
  explicit revoke/grant (no anon), and a DB test: A/B isolation, forbidden privileges, constraint rejections.
  `tests/db/rls.test.ts` guard must stay green.
- Integrity lives in constraints/functions, not only in the UI. Writes that must be atomic/idempotent → SQL function
  or unique index; concurrency-sensitive counters → row locks, tested with parallel committed transactions.
- Index only with a query that needs it. No service_role in client code. Append-only history stays append-only.
- Apply to the real project only after `npm run test:db` passes; verify with one compact query (RLS + grants).
- Supabase project ref `jeloegnvaxlfqjntbbyy` only. Never touch other projects or real user rows.
