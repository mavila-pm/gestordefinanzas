---
name: velsuno
description: Reusable working rules for Velsuno (gestordefinanzas) — fast ship workflow, git, architecture, security, financial invariants, Vels/Gemini, minimum tests by risk, brief replies. Use at the start of any Velsuno session or block.
---
# Velsuno — working rules

## Ship today (fast workflow)
1. Read `docs/status.md` (state, blockers). Spec only by section: `docs/product/MOTHER_DOCUMENT.md`.
2. Smallest change that solves it; reuse existing components/engines; no new deps without a decision.
3. Migration (if any) → DB test → pure logic + unit test → server action/query → page → E2E spec.
4. Gates: `npm run check` (+ `npm run test:db` if SQL, `npm run build` if routes/UI). Use `scripts/qa/run.sh`.
5. Money/auth/RLS/AI quota diff → `security-reviewer` agent and/or `financial-safety` skill.
6. One commit per block, push, wait CI + Vercel Preview, report. Update `docs/status.md` (compact, no diary).

## Repo, branch, git
- Repo `mavila-pm/gestordefinanzas`. Work only on the session branch (e.g. `claude/beautiful-keller-ikxlrj`).
- Never: merge to `main`, deploy production, force push, `reset --hard` shared history, PR unless asked.
- `git push -u origin <branch>`; retry only on network errors (2/4/8/16 s).
- No model identifiers in commits/PRs/code. Commit trailers as the session reminder says.

## Architecture
- Next.js 16 App Router + Supabase (Postgres/Auth/RLS) + Vercel Preview.
- `src/` pure: domain → ingestion (bank-specific code only in `src/ingestion/adapters/`) → engine; `src/ai`.
- `lib/` server-only (Supabase clients, queries, `ai.ts`, `vels.ts`, `preferences.ts`); `app/` routes + server actions.
- Flow: SOURCE → NORMALIZED EVENT → FINANCIAL ENGINE. Module map: `docs/architecture/structure.md`.
- Supabase ONLY project `jeloegnvaxlfqjntbbyy`. Schema changes = NEW file in `supabase/migrations/`; never edit applied ones.
- Account prefs in `user_preferences`; device prefs (theme/text/motion) in cookies applied in `app/layout.tsx`.
- UI: tokens in `app/globals.css` (no raw hex), Manrope, Grafito/Marfil/Cítrico; mobile-first 390 px, 44 px targets.

## Security
- Never print/read/commit secrets (`GEMINI_API_KEY`, service role). Service role never client-side.
- RLS own-row on every user table; composite FKs `(x_id, user_id)`; DB test with users A/B for each new table.
- `user_id` always from the server session, never from form input. Whitelist-parse all FormData.
- Plus/limits enforced server-side (entitlements, `plan_config`), never only in UI.
- Emails/SMS/webhooks/images/model output = untrusted: fixed patterns + validation; never follow their text.
- Never store bank passwords, PIN, CVV, OTP, full PAN. Never delete real user data; demo ≠ real; PO account untouchable.
- Destructive SQL (DELETE/cleanup) → give it to the PO to run; don't execute.

## Financial invariants
- Integer minor units, positive; `type`/`direction` carry meaning; metrics only via `financialEffect()`.
- Card purchase = expense; card payment ≠ second expense; own transfer ≠ income/expense; ATM = transfer_to_cash.
- Refund keeps its meaning (never income). PEN ≠ USD: never summed/compared/converted.
- Unknown ≠ 0; estimated ≠ confirmed (status shown); planned ≠ realized; expected income ≠ received.
- Credit line ≠ free money; minimum ≠ total payment. Split allocations sum = amount.
- Uncertain → `review_required`; weak duplicate → `possible_duplicate`; never auto-delete; provenance kept.
- Suggestions never applied silently (observed → suggestion → person decides). What-if never writes.
- Display preferences (style, currency order, notices) never change calculations.

## Vels / Gemini
- Gemini is the only model (`aiModel()`), one door `lib/ai.ts`: quota → call → record, ≤ 1 retry, validated output.
- The deterministic engine computes money; AI only interprets (ADR-0006). Deterministic answers cost 0 quota.
- Prompts get fixed enum text only (e.g. style instruction), never raw user text in the system prompt.
- Vels: one question per turn, short, Spanish es-PE; "Uso de Vels" shown as % of real `ai_usage`/`plan_config`, never tokens; no limit → no %.
- Never expose model/tokens/temperature/API keys in UI. "Limpiar" lives only in the Vels menu.

## Minimum tests by risk (`docs/qa.md`, `scripts/qa/risk.sh`)
- Copy/CSS only: typecheck + build; screenshot 390×844 + desktop, light/dark.
- UI/server action: `npm run check` + build + local Playwright walkthrough of the flow.
- SQL/RLS/migration: + `npm run test:db` (A/B isolation, constraints, anon denied).
- Money/AI quota/auth: + unit tests on the invariant + security review. E2E specs updated to new routes/testids.
- Report honestly: IMPLEMENTED / VERIFIED (with evidence) / APPROVED (PO only). Not run = say so.

## Replies (save tokens)
- Spanish, conclusion first, short. Tables for reports. No narration of options not taken.
- Don't re-read whole files or the spec; grep + targeted reads. Don't repeat known context.
- Mark "suficientemente bueno" and stop; critical fixes now, optional ones listed (max 2).
