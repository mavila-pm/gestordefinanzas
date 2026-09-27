# Runbook — end-to-end test against the real Supabase project

Requires network access from the environment to `jeloegnvaxlfqjntbbyy.supabase.co`.

1. `.env.local` with the public values (`.env.example`). Build and start: `npm run build && npx next start -p 3000`.
2. Create two confirmed probe users (`e2e-a@…`, `e2e-b@…` on a non-deliverable test domain) and seed
   transactions via the Supabase SQL tool (A: S/100 card purchase "E2E RESTAURANTE A", S/100 card payment,
   S/200 ATM withdrawal; B: "E2E SECRET B").
3. `E2E_A_EMAIL=… E2E_B_EMAIL=… E2E_PASSWORD=… node --experimental-strip-types tests/e2e/auth-dashboard.e2e.ts`
4. Delete the probe users (cascade removes their rows) and confirm 0 remain.

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
