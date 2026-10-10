# ADR-0004 — Dividir gasto: allocations of one movement

Status: Accepted (TASK-020). Date: 2026-09-28.

## Decision
A split is stored as `transaction_allocations` rows (category, amount, optional note, position) that belong to ONE
transaction. The transaction keeps amount, currency, direction, sources, fingerprint and audit trail. Money is
never created: `0 < sum(allocations) <= amount`; the unallocated remainder stays in the movement's own category.

- Writes only through `set_transaction_split` (SECURITY DEFINER owned by `app_writer`, RLS applies): atomic
  replace-all, optimistic version (`updated_at`), audited (`split`). Clients can only SELECT their own rows.
- A trigger on `transactions` refuses any update (any path, including corrections) that would break the
  invariant: amount below the allocated total, currency change, type to non-spending, status away from confirmed.
- No currency column on allocations: parts are always in the movement's currency.
- Eligible: confirmed `expense` and `credit_card_purchase`. Excluded: refund/reversal (they reduce the original
  purchase's category), ATM withdrawal (ADR-0002), card payment and internal transfer (not spending), income,
  unknown, anything pending review.
- Analytics: `categoryShares()` feeds `monthlySummary` (and therefore analysis, budgets, insights): totals count the
  movement once; categories receive the parts. CSV keeps one row per movement (full amount) plus a `División` column.
- `stale` uses SQLSTATE 55000: 40001 is retried by PostgREST and would hang until the gateway timeout.
