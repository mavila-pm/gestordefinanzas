---
name: financial-safety
description: Review a diff that can affect money in Velsuno (engine, planning, ingestion, dedupe, splits, settlements, debts, AI apply paths, financial server actions or SQL) against the financial invariants, and list concrete findings and missing tests.
---
# financial-safety
Input: `git diff <base>` limited to money paths (`scripts/qa/risk.sh` flags them). Invariants: `.claude/rules/financial.md`.
Check only what the diff touches:
- Currency: PEN/USD never mixed in sums, matches, comparisons, scenario copies.
- Units/rounding: integer minor units end to end; parse/format at the edges; rounding only for planned amounts.
- Meaning: card purchase vs card payment, transfers, ATM, refunds/reversals go through `financialEffect()`.
- Dedupe/provenance: fingerprints, `possible_duplicate`, sources preserved; no auto-delete.
- Splits: allocations sum = amount; no double counting in totals/budgets.
- Planning: planned ≠ paid, expected ≠ received, one movement settles one item, settled periods skipped, unknown ≠ 0,
  estimated flagged, horizon = today → next income, overdue look-back consistent with `buildPlan`.
- Debts: balance vs minimum vs total vs principal; missing rate → no ranking; payment ≠ expense.
- Writes: idempotent (unique keys / functions), stale-write guards, concurrency (row locks), RLS ownership, A/B.
- Suggestions: never applied without the person's decision; what-if never writes.
Output (no essay):
```
finding: <file:line> — <what breaks> — <example input → wrong result>   # or "none"
missing test: <test name / file> — <case>
```
