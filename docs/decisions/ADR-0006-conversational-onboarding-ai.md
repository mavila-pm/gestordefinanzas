# ADR-0006 — Conversational onboarding, "Preguntar" assistant, camera reads and AI entitlements

Status: ACCEPTED (implementation) · commercial values PROPUESTO · Date: 2026-09-28 · Source: PO addendum
"Conversational onboarding + Velsuno financial assistant + camera + AI entitlements" (§1-§86).

Change Request note (Anexo A): the addendum extends the Mother Document (new first-access flow, AI usage
limits per plan). The PO authored it directly; this ADR records it as the CR. The base spec it references
("Conversational Financial Discovery & Planning Engine") was later approved by the PO; its planning rules are
reconciled in ADR-0007.

## Decisions

1. **Deterministic first, AI second.** Every message is read by a local Spanish interpreter
   (`src/ai/interpreter.ts`) at zero cost. A provider is called only when nothing could be read and a provider
   is configured. Taps (confirm, start, summary, "Después") never call AI (§54-§55). Numbers always come from
   the planning engine (ADR-0005); the model never computes money (§25).
2. **The structured draft is the memory** (§23-§24). `onboarding_states.facts` holds typed facts (incomes,
   obligations, debts, accounts, variable spending, balance, asked questions, pending question). Provider prompts
   get the compact draft + the new message, never the transcript. The assistant gets a compact engine view +
   the last 6 messages; its thread is capped at 40 messages and can be cleared.
3. **One question at a time, unknown is never 0** (§5-§9, §65). `nextQuestion()` asks the single most useful
   missing fact, never twice. "No sé / Después" records `unknown`. The person can start as soon as there is an
   income and the balance was asked; pending items are listed as "Por confirmar".
4. **Onboarding feeds the planner** (§67). "Empezar" writes expected_incomes, fixed_expenses, debts,
   accounts/cards, balance_snapshots and planning_settings under the user's session (RLS). A debt with unknown
   balance is not created (nothing invented); it stays pending. Created ids are recorded in
   `onboarding_states.applied` so a demo reset removes exactly those rows.
5. **Provider abstraction** (§26, §29, §62) — *superseded by ADR-0015: Gemini is the only model; no abstraction, switch or fallback provider remains.* `AIProvider` interface; adapters: OpenAI-compatible (DeepSeek),
   Gemini, and a deterministic `fixture` (tests/demo only, refused on production). Server-side config only
   (`src/ai/config.ts`): provider, text/vision/fallback model, timeout, reasoning, max input/output per
   operation. Default is `none`: the product works fully without AI. One retry for transient failures only; a
   fallback provider only on failure/unsupported modality; never parallel calls.
6. **Entitlements are provider-independent** (§33-§47, §79-§80). `plan_config` holds weighted-token and
   camera-read limits (values below, all PROPUESTO). Weighted tokens = input + 4×output + 0.1×cached + image
   (weights configurable). Enforcement is in SQL (`ai_reserve` → provider → `ai_record`), under the user's
   session, never in the UI. Buckets: one-time `onboarding` allowance (used first while onboarding is active),
   then `m:YYYY-MM` (Free/Plus, Lima calendar) or `trial`. Per-day request and camera limits, per-user daily
   cost cap and a global daily cost guard (`ai_global_daily`) fail safe. A failed camera call gives the read
   back; each reservation settles exactly once (`ai_calls.outcome`).
7. **Usage shown in human terms** (§48-§50): a bar for conversation and "N de M" camera reads in Tu plan; never
   tokens. Reaching the limit only stops AI: dashboard, movements, review, manual entry and deterministic
   planning keep working.
8. **Images** (§12-§18, §56-§58): see the policy below.
9. **Demo** (§76-§78): `demo_access` allowlist (operator SQL, never client). Allowlisted accounts can simulate
   Free/Trial/Plus for AI limits (`set_demo_plan`, the real subscription is untouched) and "Reiniciar bienvenida
   demo" (removes exactly the rows onboarding created, the onboarding conversation, and gives back the one-time
   allowance). Enabled for avilamauro68@gmail.com (authorized in §76) and the synthetic demo@ account.

## Initial limits (plan_config, PROPUESTO/configurable — not commercial terms)

| Key | Value |
|---|---|
| ai_onboarding_tokens / ai_onboarding_camera_reads | 80,000 / 3 (one-time) |
| ai_free_monthly_tokens / camera | 25,000 / 2 |
| ai_trial_tokens / camera | 300,000 / 15 (per trial) |
| ai_plus_monthly_tokens / camera | 1,500,000 / 50 (no rollover) |
| daily requests Free / Plus | 40 / 300 |
| daily camera reads Free / Plus | 3 / 20 |
| max images per read | 3 |
| per-user daily cost cap / global daily cost guard | USD 0.20 / USD 5.00 |

## Image privacy policy (implemented)

IMAGE → TEMPORARY PROCESSING → STRUCTURED FACTS → USER CONFIRMATION → DISCARD.

- The browser re-encodes large photos to ≤1600px JPEG (drops EXIF/GPS). The server never trusts the name or
  declared type: it sniffs magic bytes (JPEG/PNG/WebP), bounds size (6 MB) and dimensions (200–8000 px), and
  strips metadata segments (JPEG APP1–APP15/COM, PNG text/eXIf/tIME) before any provider call.
- Images live only in the request's memory. They are **never written** to storage, the database or logs; the
  only persisted outcome is the structured proposal (`facts.vision`) and, after "Confirmar", the facts.
- The vision prompt asks for facts only (never CVV, keys, DNI, full numbers — last 4 digits only); the
  response is validated like any untrusted input (`validateVision`). Nothing is applied without confirmation;
  doubtful fields are marked "Confirma".
- Text messages pass through `sanitizeUserText` before storage or any provider: CVV/PIN/passwords/OTP/tokens/
  bank keys are replaced by "[omitido]", DNI dropped, card/account numbers reduced to `•••• 1234`.
- Provider data retention depends on the provider's terms and must be reviewed when one is contracted.

## Not done yet (honest scope)

- No real provider is enabled: needs PO choice + API key (resolved by ADR-0015: Gemini). Without it,
  inference paths return "no disponible" and the deterministic features cover the common cases.
- Camera inside "Preguntar" (§70) and "observed replaces estimated" suggestions (§68): done in ADR-0007.
- Voice is not shown (§11). Internal cost dashboard (§82) is SQL over `ai_calls` (queries in the runbook), no UI.
