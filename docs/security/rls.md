# Row Level Security model

Migrations: `supabase/migrations/`. Evidence: local `npm run test:db` (tests/db/rls.test.ts) and the RLS probe on the
real Supabase project (`docs/runbooks/supabase-migrations.md`). Supabase security advisors: exceptions documented below ("Function grants").

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

## Function grants (migration 049)
Guard: `tests/db/rls.test.ts` ("function EXECUTE grants"). A new function that anon can execute, or a new SECURITY
DEFINER function that authenticated can execute, fails CI until it is reviewed and added to the allowlist there.
Trigger functions are executable by no client role (triggers fire without EXECUTE); every SECURITY DEFINER function
pins `search_path`. Migration 049 revokes EXECUTE on every trigger function in `public` and aborts if one is still
executable afterwards.

Supabase advisor exceptions (accepted unless marked planned):

| Lint | Objects | Decision |
|---|---|---|
| 0028 anon_security_definer_function_executable | `cap_spend` | Accepted: /api/cap redeems before sign-in; a key is useless without the Cap secret (ADR-0016). Table growth: purge pending (PO). |
| 0028 anon_security_definer_function_executable | `login_attempt` | **Planned**: anyone with the publishable key can keep an email locked for password sign-in (the email link and recovery still work). Fix = server-only gate + revoke anon (owner decision, ADR-0016). |
| 0029 authenticated_security_definer_function_executable | the 23 names in `AUTHENTICATED_DEFINER` (rls.test.ts) | Accepted: the designed write path (ADR-0003); each checks `auth.uid()` itself. |
| 0008 rls_enabled_no_policy | `cap_spent`, `inbound_deliveries`, `login_throttle`, `registration_phone_refusals` | Accepted: server/function-only ledgers, deny-all for clients on purpose. |
| auth_leaked_password_protection | Auth setting | Planned: PO turns it on (may need a paid plan). |

Registration (049): `finish_registration` replaces `complete_registration` (kept, executable by no client role). It is final
once the account is complete (`already_registered`, nothing rewritten) and answers `phone_taken` at most 5 times per
account per 24 h (`too_many_attempts` after that, even for a free number), so a signed-in account cannot enumerate
which +51 numbers have an account. Residual: each new account (one real inbox each) gets its own 5 answers.

Live check after applying (expected: only `cap_spend`, `login_attempt`; extension functions are left out, as in the test):
`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'EXECUTE') and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') order by 1;`

Rollback of 049 (registration only; the trigger-function revoke needs none). Granting `complete_registration` again
is not enough on its own: the app falls back to it only on PGRST202 (function missing), never on a permission error.
- With a deploy: ship an app version that calls `complete_registration` directly, then
  `grant execute on function public.complete_registration(text, text, text, date, text, text) to authenticated;`
- Without a deploy (PO, SQL Editor; the connector cannot run a DROP):
  `grant execute on function public.complete_registration(text, text, text, date, text, text) to authenticated;
  drop function public.finish_registration(text, text, text, date, text, text); notify pgrst, 'reload schema';`
  `registration_phone_refusals` can stay (private, unused).
