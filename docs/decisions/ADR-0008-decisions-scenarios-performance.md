# ADR-0008 — Suggestion decisions, learning trail, what-if, preferences, question order, tap performance

Status: ACCEPTED · thresholds PROPUESTO · Date: 2026-09-28 · Migrations 000019–000020 (applied to `jeloegnvaxlfqjntbbyy`).

## Learning ≠ financial events
- `suggestion_decisions` (RLS, own rows): "Ahora no" = snooze `SNOOZE_DAYS` (14); "Descartar" = hidden for that
  value; a materially different value (> 10 % and > S/ 30) may be suggested again (`isSuppressed`). Kinds:
  essentials, observed_amount, income_match ("No es ese"). Hiding a suggestion never changes data.
- `learning_events`: append-only trail (SELECT/INSERT only) of changes to learned data — rule corrected/forgotten,
  settlement undone, essentials/income/variation accepted or dismissed, onboarding chat forgotten, preferences.
  Transactions are never deleted or rewritten by these paths. Best-effort write (a failed trail row is logged,
  it does not undo the person's change).

## Planning
- Income matching: a deposit that fits two expected incomes equally is `ambiguous` (medium) — the person picks.
- What-if (`src/engine/scenarios.ts`, pure, never writes): `delayIncome` (horizon stretches), `changeBill` (copy of
  one obligation), `payDebt` (money leaves now; it covers the card's planned payment in the horizon, never counted
  as a new expense; interest saved only with a known rate), `comparePayoff` (avalanche / snowball / hybrid with
  months and interest; any missing rate → no ranking, names the missing rate), `extraDebtPayment`.
- Preference `planning_settings.allow_zero_for_debt` ("No me importa quedarme en cero si pago deuda"): set only
  after a confirm tap (Preguntar) or the Dinero libre sheet; it lets the suggested extra payment use the cushion
  and always shows the trade-off ("quedas en S/ 0 libre hasta el …"). Revertible; logged.
- Onboarding next question by impact: income → today's balance (blocks Dinero libre) → payment dates (incl. card
  due day) → payment amounts → card minimum → debt balances → completeness.

## Tap → response (measured with `scripts/e2e.sh perf`, 390 px, container → us-east-1)
| Interaction | Before | After | Cause → fix |
|---|---|---|---|
| Tab / link navigation | 260–510 ms with no visible change | feedback 6–36 ms, page ~330 ms | No route fallback; auth round trip per request → per-route `loading.tsx`, `useLinkStatus` marker, `getClaims()` (ES256, local verify) in proxy/layout/actions |
| Save (sheet form) | busy state 264 ms, done ~620 ms | busy 16 ms, done ~360 ms | Grey disabled button looked dead → pulsing busy state, same width; plan page did a second sequential read → parallel |
| Preguntar send | no echo until the answer | own message 27 ms, answer ~360 ms | `useOptimistic` echo (own words only, never a financial result); turn loads view + history in parallel |
Not done: `/app/movimientos/[id]` has no skeleton on purpose — a route fallback streams 200 before `notFound()`,
which would break the 404 for other users' ids (regression caught by `review-manual`).
