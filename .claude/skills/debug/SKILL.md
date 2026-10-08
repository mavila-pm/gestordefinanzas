---
name: debug
description: Where to look and known failure causes when something breaks in Velsuno (tests, E2E harness, auth links, AI answers, build, Supabase). Use when a check fails or the app misbehaves, before changing code.
---
# debug
Method (`docs/agent-workflow.md#debugging`): reproduce → classify app / test / data / env → evidence → one hypothesis →
smallest change → re-run the same check. A second attempt needs new evidence.

## Evidence locations
- Any command run via `scripts/qa/run.sh <label> -- …` → `.qa/<label>.log` (full output, real exit code).
- E2E: `.e2e/server.log`, `.e2e/build.log`, screenshots `.e2e/shots/`, probe runs `.e2e/runs.json`.
- Supabase (MCP): `get_logs` (api, auth, postgres), `get_advisors` (security/performance), `execute_sql` for one compact
  query. AI calls: table `public.ai_calls` (outcome, provider, model, latency; never prompts).

## Known causes (seen in this repo)
| Symptom | Cause → fix |
|---|---|
| E2E check fails after an earlier partial run | suites mutate their probe users → reseed the pairs: `scripts/e2e.sh render-seed s13a s13b` |
| E2E text check fails after a copy change | suites assert visible copy: grep the old string in `tests/e2e/` and update it in the same change |
| A dated E2E check fails near a month boundary | seed rows are relative to the Lima month (`m0`, clamped to today); keep new fixtures relative, never pinned |
| `duplicate key … users_email_partial_key` on an e2e user | stale seed; seeds are run-scoped (`render-seed` = new run id). Fix the harness, never delete by hand |
| MCP `execute_sql` hangs ~60 s | the connector does not run `DELETE`; use `E2E_DB_URL` + psql for cleanup |
| Auth email link opens localhost / Site URL | Redirect URL must equal `<base>/auth/confirm` exactly; base from `siteUrl()` in `lib/env.ts` |
| Route returns 200 instead of 404 | a `loading.tsx` above a `notFound()` streams the response |
| Vels/onboarding say "todavía no está activa" | `aiConfig()` → provider `none`: `AI_PROVIDER` unset, key missing, or unpriced `OPENROUTER_MODEL` (`src/ai/config.ts`) |
| AI stop `ai_rate` / `ai_quota` / `ai_budget` | raised by SQL `ai_reserve` (`grep -l ai_reserve supabase/migrations`); reasons and copy in `lib/ai.ts` `STOP_TEXT` |
| A new E2E probe lands on /crear-cuenta | accounts created after 2026-10-08 05:00 UTC must finish registration: seeds insert `profiles(password_set_at, registration_completed_at)` (except the registration suite's s16a) |
| Form loses what was typed after an error | React 19 resets a form after its action: keep inputs controlled (`components/auth-form.tsx`, `profile-form.tsx`) |
| Font file downloaded twice / CLS on load | next/font const named like a token `@font-face` family (case-insensitive); keep `velsunoSans` in `app/layout.tsx` |
| `npm run test:db` cannot start | needs PostgreSQL ≥ 15 binaries (`PG_BIN=/usr/lib/postgresql/16/bin`) |
| App refuses to start: secret/service key | `lib/env.ts` rejects `sb_secret_`/service_role as the public key — correct the env var |

Fix the root cause; never raise a timeout, skip a test, or weaken an assertion to get green.
