# ADR-0012 — Idempotent creates (atomic, not the button)

Status: ACCEPTED · Date: 2026-09-29 · Migration 000024 (applied).

- Problem: two tabs, a double tap or a retried request could create the same debt/payment/income/account twice.
  A disabled button is UX, not a guarantee.
- `client_ref text` (format `^[A-Za-z0-9:_-]{8,120}$`) on `fixed_expenses`, `debts`, `expected_incomes`, `accounts`,
  with a unique partial index `(user_id, client_ref) where client_ref is not null`. The database decides; the second
  insert fails with 23505 and the server treats it as a replay (success, nothing written). `user_id` still comes from the
  session (RLS `with check`), never from the client.
- Refs: `ActionForm` sends one UUID per submission (renewed after success); Vels `create_debt` → `vels:<uuid>` minted
  when the proposal card is built (same card confirmed twice = one row); camera → `vis:<messageId>:<n>`; onboarding →
  `onb:<table>:<n>` (a replay undoes its own partial rows and reports ok).
- Updates stay naturally idempotent (same values); settlements already had `(user_id, fixed_expense_id, period)` unique.
- Tests: `tests/db/idempotent-creates.test.ts` (5 parallel committed inserts → 1 row + 4×23505; per-user scope; bad ref
  → 23514; foreign user_id → 42501); E2E vels "same confirmation again writes nothing more".
- Review follow-up (000027): a replayed ref counts as success only while its row is still live (apply_plan →
  `plan_closed` for a removed/replaced plan; Vels debt → "ya no está activa"); onboarding refs carry the attempt
  (`started_at`) and a replay reports success only once the other request really completed.
