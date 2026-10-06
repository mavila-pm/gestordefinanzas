# Runbook — end-to-end test against the real Supabase project

Requires network access from the environment to `jeloegnvaxlfqjntbbyy.supabase.co`.

1. `.env.local` with the public values (`.env.example`).
2. Seed: `E2E_PASSWORD=<random> scripts/e2e.sh render-seed [tags…]` and run the output with the Supabase SQL tool
   (or set `E2E_DB_URL` and the script seeds/cleans via psql). The seed is **insert-only**: each render gets a fresh
   run id and creates new users `e2e-<tag>-<run>@gestordefinanzas.invalid` (fixed B ids = `md5('<run>:<name>')`),
   recorded per tag in `.e2e/runs.json` (the suites read it). So it can run again, and it never depends on an earlier
   cleanup: leftovers of a previous run cannot collide. One A/B pair per suite; the password is never committed.
   Guards: the run id must match `^[a-z0-9]{8,20}$` and every email the exact synthetic pattern, or the seed aborts.
3. `E2E_PASSWORD=<same> scripts/e2e.sh [suite…]`: stops its previous server (PID file, own process group), refuses a
   foreign process on the port, builds only if sources changed, waits for `/login` = 200, runs the suites, prints one
   line per suite + failures with a one-step diagnosis (URL, alerts, page excerpt, server log) and always stops the server.
4. Cleanup: `tests/e2e/cleanup.sql` → must return `probe_users = 0` and `orphan_rows = 0`. It deletes only
   `^e2e-s<n><a|b>(-<run>)?@gestordefinanzas.invalid$` (all runs; rows go through the user_id cascades, all ON DELETE
   CASCADE) and aborts without deleting if anything matches the prefix but not that pattern, or if the count is
   implausible (> 400). Verified in `tests/db/e2e-seed.test.ts`: seed → seed again → partial cleanup → seed → cleanup
   (0|0, real users untouched) → cleanup again → seed.

### Incident 2026-10-06 (duplicate `e2e-s4a`, 60 s timeouts)
Cause: the old seed began with `delete … ; insert …`. Through the Supabase MCP connector any SQL containing a DELETE
(top level or inside `DO`, even 1 row) hangs until the connector's 60 s timeout and is not executed, while the same
DELETE inside `begin … rollback` (EXPLAIN ANALYZE) takes 96 ms, `UPDATE`/`INSERT` are instant, a 5 s `lock_timeout` /
20 s `statement_timeout` never fire, and Postgres shows no blocker, no long query and no log error. So: not a slow
operation in the database; the connector does not run DELETE statements in this session (likely an unsurfaced
confirmation). Earlier separate seed calls then inserted over users that were still there → duplicate key.
Fix: insert-only seed under a run id (above). Cleanup still needs a DELETE: run it with `E2E_DB_URL` (psql) or when the
connector executes deletes again; leftovers meanwhile are synthetic, `.invalid`, emailless and harmless.

No email is sent to the probe domain: the tests use existing (confirmed) and unknown addresses only,
avoiding bounces that could get the project's email sending restricted.
Real signup confirmation and password-reset emails must be checked manually with a real inbox.

## Seeding notes
Probe users are inserted directly into `auth.users` (bcrypt via `extensions.crypt`, `email_confirmed_at = now()`,
token columns set to `''` — GoTrue fails on NULL) plus a matching `auth.identities` row (provider `email`).

## Last result — 2026-09-27 (TASK-003)
Environment network access to `jeloegnvaxlfqjntbbyy.supabase.co` enabled. **11/11 passed** against the real project:
redirect without session, generic login error (wrong password = unknown email), login A → dashboard,
A expenses = S/ 100.00 (card payment and ATM withdrawal excluded), A sees own merchant and not B's (RLS),
withdrawal shown apart, logout, neutral forgot-password and signup-existing messages.
Fix needed on first run: the test's `[role=alert]` selector also matched Next.js's route announcer; it now
excludes `#__next-route-announcer__` (test defect, not an app defect). Post-check: 0 probe users, identities or rows left.

## TASK-004 — review queue, manual entry, secure writes (`tests/e2e/review-manual.e2e.ts`)
Requires migration 000004 applied to the project. Seed (SQL tool), then run with the same env plus
`E2E_B_TX_ID=<B's transaction id>` and the two `NEXT_PUBLIC_SUPABASE_*` values:
- A: `expense` S/100 PEN, BCP, `card_last4 '4821'`, merchant "E2E REVIEW A", category Otros, `status review_required`,
  `confidence medium`, 2026-09; plus an `sms` source (`BCP_SMS_V1`) and a `financial_events` row (`created`,
  detail `card_not_registered`). No cards registered for A.
- A also: `expense` S/40 "E2E DUP A", Alimentación, `possible_duplicate`, `duplicate_of_id` = the first item;
  account "E2E Ahorros" (BCP, PEN, 9001).
- B: `expense` S/50 "E2E SECRET B", `review_required`.
Checks: reasons in plain language, card registration + correction + confirm, audit shows the original amount,
manual withdrawal not counted as expense, B's movement is a 404, and direct API writes with A's JWT are denied.
Clean up as in step 4 (cascade removes rows, sources, events and audit events).

### Last result — 2026-09-27 (TASK-004)
**46/46 passed** against the real project after applying migration 000004: queue with plain-language reasons
(no internal terms) and pending badge; ignore a possible duplicate (row kept, status ignored); register card →
correct amount/category/card/account → confirm; history shows S/ 100.00 → S/ 95.50; manual ATM withdrawal not
counted as expense; B's movement is a 404; with A's own JWT, direct INSERT/UPDATE/DELETE on transactions, writes to
transaction_sources/financial_events/audit_events and calls on B's rows are denied (42501 / not_found);
correct_transaction rejects provenance/status/direction fields; original SMS source and ingestion event intact;
audit before/after exact for correct and ignore.
Plus: "Confirmar" button (review_transaction) verified on the real project; server-side check: B never updated,
0 audit rows for B, fingerprints unchanged. Post-check: 0 users, identities, transactions, sources, events,
audit events, cards, accounts, user categories and profiles.
First run failures were test defects (fixed): an unscoped `button[type=submit]` hit the header logout button,
and JSON comparisons depended on jsonb key order.

### Regression — 2026-09-27 (after migration 000004 and the auth redirect fix)
`tests/e2e/auth-dashboard.e2e.ts` **13/13** against the real project (11 original checks + 2 new: signup and
recovery store the post-link destination in the `gf_auth_next` cookie). Supabase edge logs confirm
`redirect_to=http://localhost:3000/auth/confirm` (no query string) for `/signup` and `/recover`.
Test fix: logout now waits for the `/login` URL (server-action redirect is a client-side navigation, so
`networkidle` could time out). Probe users deleted; 0 left.

## Full regression — 2026-09-28 (autonomous phase, TASK-003..013)
All suites against the real project, fresh probe users per suite (seeded via SQL, `.invalid` domain, no emails sent):
`auth-dashboard` 13/13 · `review-manual` 46/46 · `import-learning` 27/27 · `analysis-dashboard` 26/26 ·
`planning-account` 18/18 → **130/130**. Test fixes during the run (not app defects): server actions re-render in
place, so assertions now wait for the text to change instead of a fixed sleep. Post-check: 0 probe users and 0 rows
in every user table (only the PO's 2 real accounts remain).

## Regression on the new E2E infrastructure — 2026-09-28
`scripts/e2e.sh` + `tests/e2e/lib.ts` (no fixed sleeps) + `seed.sql`: 13 + 46 + 27 + 26 + 18 = **130/130**.
Cleanup: probe_users 0, orphan_rows 0 (only the PO's 2 real accounts remain).

## Regression after TASK-014..018 — 2026-09-28
13 + 46 + 30 + 28 + 22 = **139/139** (9 new checks: card auto-link, recurring Free/Plus, amount search + injection,
sync history). The review-manual audit assertions now expect the `card_link` event created when the card is
registered (behavior change of TASK-014, same strictness). Cleanup 0|0.

## Regression after Velsuno UI + splits (TASK-019..020) — 2026-09-28
13 + 46 + 30 + 28 + 22 + 18 = **158/158** (new suite `splits`), plus `visual`: 54 real screenshots at
320/375/390/430/768/1024/1280/1440 (saved for 320, 375, 1280), light and dark, 0 horizontal overflow. Test updates
caused by the redesign (same assertions): saved notice after "Guardar y confirmar", delete behind a disclosure,
detail meta testid. Cleanup 0|0.

## Regression after the UX pass (TASK-021) — 2026-09-28
13 + 46 + 30 + 32 + 23 + 18 = **163/163**, plus `visual`: 114 screenshots (all authenticated routes, 8 widths, light/dark),
0 horizontal overflow, 0 UX audit issues (console errors/hydration, duplicate ids, unlabeled fields, touch targets < 40px on
mobile). Lesson: a route-level `loading.tsx` made streamed pages answer 200 before `notFound()` (another user's movement
must be 404) — removed. Cleanup 0|0.

## Cash-flow planning (TASK-022) — 2026-09-28
New suite `cashflow` (seed s11: synthetic demo — balance S/ 5,000, salary on the 15th, car 9–10 paying on the 7th,
card, internet with unknown amount, phone, rent after the income, yearly insurance, electricity 129→160, unlinked car
payment, a salary that just came in, two debts one without rate). Assertions are date-independent (arithmetic and
honesty rules). Full regression: 163 + 24 = **187/187**; visual 132 screenshots, 0 overflow, 0 UX issues.

## Conversational onboarding + AI usage (ADR-0006) — 2026-09-28
New suite `onboarding` (seed s12: s12a first-time user, demo-allowlisted; s12b another user with its own
conversation/usage/income). `scripts/e2e.sh` starts the server with `AI_PROVIDER=fixture AI_ALLOW_FIXTURE=1`, so
inference paths (reservation, validation, usage recording, camera) run with synthetic answers and the synthetic
images of `tests/fixtures/ai/vision` (regenerate with `scripts/gen-vision-fixtures.ts`). Every other probe user
is seeded with onboarding completed. Full regression: 187 + 38 = **225/225**; visual 144 screenshots (adds
Preguntar and the welcome conversation), 0 overflow, 0 UX issues. Cleanup 0|0.

Internal cost view (§82), run with the SQL tool:
```sql
select provider, model, operation, count(*) calls, sum(input_tokens) input, sum(output_tokens) output,
  sum(est_cost_micro_usd)/1e6 usd, avg(latency_ms)::int avg_ms,
  round(100.0 * count(*) filter (where outcome <> 'ok') / count(*), 1) error_pct
from public.ai_calls where created_at > now() - interval '30 days' group by 1, 2, 3 order by usd desc;
select percentile_cont(array[.5,.9,.95]) within group (order by weighted_tokens) from public.ai_usage where bucket like 'm:%';
```

## Perf probe
`scripts/e2e.sh perf` (seed s11a): prints `PERF` rows (tap → first visible feedback, tap → result) measured in the page from `pointerdown`; fails if any feedback > 100 ms.

## Partial seed
`scripts/e2e.sh render-seed s13a s13b` renders only those pairs (delete + recreate, only their branches; ~3.5 KB instead of ~16 KB) — use it to reseed the suites you re-run. Pair map: header of `tests/e2e/seed.sql` (s13* = income-link).

## Perf — 2026-09-29 (local prod build → real Supabase, 390 px, warm, median of 3; noise ±50 ms)
Tap feedback: nav 8–37 ms · sheet 19 ms · save 12 ms · Vels send 26–41 ms (all < 100 ms). Done: nav ~330 ms, save 279 ms, Vels answer ~530 ms.
HTML render before → after parallelizing card reads with the plan load: `/app` 201→218 · `/app/plan` 217→164 · `/app/movimientos` 255→199 ·
`/app/tarjetas` 229→208 · `/app/compromisos` 191→248 · `/app/preguntar` 253→190 ms. Only Tarjetas/Vels changed; the rest is run-to-run noise.
