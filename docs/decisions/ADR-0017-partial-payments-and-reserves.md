# ADR-0017 — Partial payments (abonos) and Apartados (named reserves)

Status: PROPOSED — implemented and verified on branch `wf/front-c-planning`; needs PO approval (Preview walkthrough).
§F (time-aware reserve) is **PENDING PO APPROVAL** and ships switched off. Date: 2026-10-22.
Migrations 20261020000051–53 (**not applied**; 052 contains DROP → SQL Editor, see the migrations runbook).
Extends ADR-0005 (planning) and ADR-0013 (Aplicar plan); does not change their accepted rules unless stated.

## Context
`plan_settlements` was binary per (payment, month): any linked movement closed the occurrence whatever its amount,
so S/ 500 linked to a S/ 1,500 rent left S/ 1,000 as free money and then read as "Alquiler bajó S/ 1,000". A Vels
button could settle with a USD, pending or income movement. A skipped month showed "Pagado". A debt "Registrar pago"
of any amount settled the month's installment and silently capped an overpayment. There was no way to set money
aside with a name ("Viaje", "SOAT"), and money set aside was counted as free.

## Decisions
**A. One settle path + SQL guard (051).** Every "this movement paid that" (Dinero disponible, Próximos pagos, Vels)
goes through `lib/settlements.ts`. Trigger `plan_settlements_guard` (search_path '', not callable by clients) rejects
23514 when the movement is not `confirmed`; for a payment, when it is not outgoing, is an income/deposit, or is in
another currency; for an income, when it is not an income in the same currency. One movement still settles one item.

**B. Partial payments (052).** Status `paid | partial | skipped`. A `partial` row is always a payment linked to a real
movement. Several abonos per occurrence, exactly one closing row (`paid` or `skipped`, partial unique index); nothing
is linked after it closed (guard, serialized per payment+month with `pg_advisory_xact_lock`, 23505). **No amount
column: paid = Σ of the real linked movements** (confirmed, same currency), never a typed number.
- The person chooses "Pago completo" or "Fue un abono" when the movement is smaller than what remains (never
  assumed). The server stores the status from real amounts (`settlementStatus`): full → `paid`; abono → `paid` only
  when Σ real ≥ a known planned amount, otherwise `partial`. Unknown planned stays unknown (never 0, never "covered").
- Engine: remaining = max(0, planned − Σ abonos) (`remainingMinor`); the plan reserves only what remains; the line
  says "Pagaste X de Y · faltan Z". Variations and observed amounts read only CLOSED months (Σ of their movements),
  so an abono is never a price drop. Subscriptions count abonos as paid money but keep the period open.
- "No lo pago" is refused while a month has an abono (server and UI); "Deshacer" removes one row by id.

**C. Skipped ≠ paid.** `occurrenceState` → `paid | skipped | partial | open`; Próximos pagos shows "Omitido" / "Faltan
S/ X"; `reconcile` (Aplicar plan) counts real Σ as realized and never a skipped line.

**D. Debt abono (no migration).** `debtPaymentEffect`: balance −= the real amount; the installment (min(installment,
balance)) is settled — `installments_paid + 1`, `last_payment_on` — only when the payment covers it. A smaller payment
is an abono: the installment stays pending and the plan keeps reserving it. Above the balance → refused ("El pago
supera el saldo (S/ X)."), 0 rows. Unknown installment → never counted as paid.

**E. Apartados (053).** `reserves` (name 1–40, one currency for life, optional `target_minor`, `target_date` only with
a target, one active name per currency, `client_ref`) and append-only `reserve_entries` (`in` = Apartar, `out` = Usar,
1..1e11, optional link of an `out` to the real movement it paid — confirmed, outgoing, not income, same currency, one
entry per movement). **Apartar / Usar are internal allocations of the person's own money: never an income nor an
expense, no transaction, no balance snapshot change.** Saved = Σ in − Σ out (view `reserve_balances`,
security_invoker). Guard: the apartado row is locked FOR UPDATE, so concurrent entries serialize; never more out than
saved; no entries once archived; an apartado with money cannot be archived. RLS own rows; revoke all; grants
select/insert (+ update of name/target/date/active only); entries have no update/delete grant.
- Engine (`src/engine/planning.ts`, same currency only, PEN ≠ USD):
  - saved > 0 → line `fund` "Apartado: {name}" with the real saved amount (never rounded): **set-aside money is not
    free money**. Assumption: apartados live inside the declared balance. A plan that distributes a new income does
    not subtract them again.
  - target and date → line `reserve` = `reserveContribution` = roundUnit(need × horizon days / days to the date),
    capped at need; date inside the horizon → all of the need. No target or no date → nothing planned.
  - `reserveProgress`: remaining, ratio, months left = max(1, ceil(days / 30.4375)), **suggested monthly = remaining /
    months left** in whole units (roundUnit, planned amounts only); the last month asks for exactly what remains.
    No target → no ratio and no remaining (unknown ≠ 0).
- One write path `lib/reserves.ts` (`moveReserve`) for the sheets and Vels; amounts parsed on the server
  (`parseReserveForm`, `parseReserveEntryForm`); a replayed `client_ref` answers success without a second row.
- Vels (local, 0 AI quota): "¿cuánto llevo para el viaje?" answers from `reserveProgress`; "aparta 200 para el
  viaje" / "usa 100 del viaje" produce a confirmation card (`reserve_in` / `reserve_out`, one-time `vels:` ref); the
  write happens only on tap, through `moveReserve` and the SQL guard. Gemini cannot route to these intents.
- UI name: **Apartados** (section in Dinero disponible after Meta de ahorro). "Meta de ahorro" (monthly, ADR-0005)
  stays as it is: it is not a reserve.

**F. Time-aware reserve for infrequent payments — PENDING PO APPROVAL.** Today (accepted ADR-0005) a yearly or
quarterly payment due after the horizon reserves amount × horizon days / period days (SOAT S/ 600 due in 36 days,
15-day horizon → S/ 25; the next horizon then needs the full S/ 600). Proposed: amount × horizon days / days left
until it is due (same `timeShare` as apartados) → S/ 250. It changes the Dinero disponible figure people already see,
so it ships behind ONE switch, `INFREQUENT_RESERVE_RULE` in `src/engine/planning.ts`, set to `'proportional'`. Both
rules are unit-tested. To enable after approval: set it to `'time_left'` and note the change in ADR-0005.

**G. Stale balance.** `isBalanceStale` (pure, engine): older than 7 days, or money moved in the account after it in
the same currency (income, expense, cash out, refund); a card purchase and own transfers do not count.

## Invariants kept
Planned ≠ paid (paid only from real linked movements) · unknown ≠ 0 · a movement settles at most one item · PEN ≠ USD
everywhere (settle, abonos, apartados, Vels) · integer minor units; roundUnit only for planned amounts · the server and
SQL decide; client JSON and model output are re-validated · AI never computes money (Vels renders engine numbers) ·
append-only histories stay append-only · nothing applied silently (abono vs pago completo is the person's choice).

## Consequences and limits
- No debt payments ledger yet: a debt abono cannot be undone from the app and is not linked to a movement; "remaining
  installment" for debts is a follow-up (the plan conservatively keeps the full installment).
- Incomes have no partial state (one row per period, unchanged).
- The `out` → movement link exists in the schema and guard; there is no UI for it yet.
- E2E for these flows needs the real project (not run here): owner action.

## Tests
Unit: `tests/partial-payments.test.ts`, `tests/payment-link.test.ts`, `tests/debt-payment.test.ts`,
`tests/reserves.test.ts`, `tests/reserve-actions.test.ts`, `tests/vels-reserves.test.ts`, `tests/balance-stale.test.ts`.
DB (throwaway PG16): `tests/db/planning.test.ts` (guard), `tests/db/partial-settlements.test.ts` (5 parallel closes →
1, abono racing a close), `tests/db/reserves.test.ts` (5 parallel withdrawals → 1, A/B, anon, 42501 on
update/delete/currency/owner, archive, links, constraints, client_ref); `tests/db/rls.test.ts` guard green.
