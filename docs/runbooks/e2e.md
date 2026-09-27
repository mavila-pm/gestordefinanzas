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
