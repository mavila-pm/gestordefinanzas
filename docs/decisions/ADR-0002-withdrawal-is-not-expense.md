# ADR-0002 — ATM withdrawal is not an expense

**Status:** APPROVED by Mauro (Product Owner) · 2026-09-27

## Decision
- An ATM withdrawal is `type = withdrawal`, `direction = outflow`, `financial_effect = transfer_to_cash`.
- It is **not** counted in "Gastos del mes". Net worth does not change: bank −S/200, cash +S/200.
- The UI may show it as "Retiro de efectivo — S/ 200", reported apart (`cashWithdrawalsMinor`).
- Cash spending is recorded as it happens (manual entry), avoiding double counting:
  ATM S/200 + taxi S/30 + almuerzo S/45 → expenses **S/75**, not S/275.

## Future (not implemented in UI)
Optional user preference "Considerar retiros de efectivo como gasto" (`withdrawalsAsExpense`, default `false`).

## Enforcement
- Single mapping `src/domain/financial-effect.ts`; calculations use it, never `type` directly.
- Mandatory test: `tests/financial-model.test.ts` → "ATM S/200 + cash taxi S/30 + cash lunch S/45 = S/75".
