---
paths:
  - "src/domain/**"
  - "src/engine/**"
  - "src/ingestion/**"
  - "src/ai/apply.ts"
  - "src/ai/vels-answers.ts"
  - "src/ai/draft.ts"
  - "lib/planning.ts"
  - "lib/vels.ts"
  - "lib/onboarding.ts"
  - "lib/learning.ts"
  - "app/**/actions.ts"
  - "tests/*.test.ts"
---
# Financial invariants (never break; add a test when you touch one)
- Card purchase = expense. Card payment ≠ new expense (it settles a planned payment / lowers debt).
- Own transfer ≠ income/expense. ATM withdrawal = `transfer_to_cash`, not an ordinary expense (ADR-0002).
- Refund/reversal keeps its meaning (never income). Metrics only through `financialEffect()`.
- PEN ≠ USD: never summed, matched or compared across currencies.
- Split never duplicates the total (allocations sum = amount).
- Planned ≠ paid; expected income ≠ received income; a real movement settles at most one planned item.
- Unknown ≠ 0; estimated ≠ confirmed (status travels with the value, shown as "estimado").
- Credit limit / available line ≠ free money. Minimum payment ≠ total payment. Principal ≠ total with interest.
- Manual correction > rule > inference. Dedupe preserves provenance (sources kept, never silently deleted).
- Suggestions are never applied silently: observed → suggestion → person decides (Usar / Ahora no / Descartar).
- What-if scenarios work on copies and never write. Rankings need complete data (missing rate → no ranking).
- Money is integer minor units; rounding only for planned amounts (`roundUnit`), never for real movements.
Use the `financial-safety` skill to review a money-affecting diff.
