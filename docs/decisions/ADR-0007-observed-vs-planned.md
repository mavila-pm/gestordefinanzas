# ADR-0007 — Observed vs planned: income links, observed amounts, timeline, camera in Preguntar

Status: ACCEPTED (implementation) · thresholds PROPUESTO · Date: 2026-09-28 · Source: PO spec
"Conversational Financial Discovery & Planning Engine" (approved) + ADR-0005/0006. No migration.

## Decisions
1. **Expected income ≠ received** (`src/engine/observed.ts#suggestIncomeMatches`). A confirmed `income` movement is
   *suggested* as an expected income's occurrence when its date is within ±5 days of the expected day/window and
   its amount agrees (±5 % confirmed, ±25 % estimated; date-only = `medium` when the amount is unknown). Same
   currency only; one deposit ↔ one occurrence. The person confirms ("Sí, es ese" in Dinero libre, or "ya me
   pagaron" in Preguntar) → `plan_settlements.expected_income_id` → the horizon moves to the next income.
   The server re-checks the movement is a confirmed income before linking.
2. **Observed replaces estimated only on request.** Unknown payment amounts get "Internet: pagaste S/ 89 · Usar /
   Todavía no" from the last linked payment (`observedAmountsForUnknown`; "Todavía no" = `variance_ack`). Known
   estimated amounts keep the existing variation flow (ADR-0005). Essentials estimate vs observed
   (`essentialsSuggestion`): Alimentación + Transporte, ≥2 complete months with ≥5 movements each, average of up to
   3; not shown under 10 % / S/ 30. The accepted value is recomputed server-side, never taken from the form.
3. **Timeline** (`timeline`): expected incomes and unpaid planned payments from −31 days to +35, date-ordered,
   every item keeps its status (estimated / unknown / overdue / "esperado, aún no registrado"); undated items last.
   PEN and USD are never summed.
4. **Camera in Preguntar** reuses the onboarding pipeline (`readImages`: sniff/strip → provider → `validateVision`
   → proposal). The proposal waits in the Velsuno message row (`card.vision`, stripped before reaching the
   browser); only the latest Velsuno message can be confirmed. `visionWrites` re-validates the stored patches as
   untrusted input and **updates** the matching payment/debt/card (same name, or the single one of that kind and
   currency) instead of duplicating; only fields the document shows change; unknown stays unknown.
5. **Correct / forget from UI** ("Lo que recuerda"): undo a confirmed payment/income link (the movement is
   untouched) and delete the onboarding conversation + draft (rows already saved stay; `applied` kept for exact
   demo reset). Preguntar keeps "Limpiar conversación".

## Not done (honest scope)
- Essentials suggestion has no "dismiss" memory: it shows while the gap persists (no schema change for this).
- Income match needs the deposit as a confirmed `income` movement; salaries arriving only as pasted/unknown types
  are not matched. No real provider yet: camera E2E runs on the fixture provider.
