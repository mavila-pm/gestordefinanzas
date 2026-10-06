# Status — current state (not a diary; history lives in git + ADRs)

States: IMPLEMENTED · VERIFIED (reproducible evidence at the level `docs/qa.md` requires) · APPROVED (PO).
Branch `claude/beautiful-keller-ikxlrj` (PR mavila-pm/gestordefinanzas#1, Vercel Preview per push). Supabase `jeloegnvaxlfqjntbbyy`,
migrations applied through `20260929000027`.

## Checkpoint (2026-09-29)
Last full regression: unit 302 · DB 104 · E2E 289/289 (10 suites; 1 month-end bug found and fixed, re-run 23/23) · visual 162 shots, 0 overflow, 0 UX issues · perf probe 8/8 · cleanup 0|0.
Agent workflow migrated (ADR-0009): core CLAUDE.md + path rules + skills `verify` / `task-close` / `financial-safety`.

## Product areas
| Area (TASKs) | State | Pending |
|---|---|---|
| Auth + RLS shell (003, 015) | VERIFIED · manual PARTIAL | PO: recovery/password change on a real inbox; paste `token_hash` email templates (`docs/architecture/auth.md`) |
| Review queue, manual entry, secure writes, splits, dedupe (004, 013, 020) | 004 APPROVED · rest VERIFIED | — |
| Accounts/cards, learning rules, card auto-link (005, 014) | VERIFIED | — |
| Imports: pasted BCP notifications (006) | VERIFIED (pipeline) | Real BCP samples: templates remain SYNTHETIC_UNVERIFIED |
| Email Bridge (009) | PARTIALLY VERIFIED · real BLOCKED | Inbound provider, domain + MX, server secrets |
| Movements, analysis, CSV, milestones, insights, sync history, search (007, 008, 017, 018) | VERIFIED | — |
| Budgets, fixed expenses, debts, plans/trial/entitlements, recurring (Plus) (010–012, 016) | VERIFIED | Billing provider + price; limits shown, not enforced (PO) |
| Velsuno UI + product UX pass (019, 021) | VERIFIED | PO walkthrough on a real phone |
| Cash-flow planning: Dinero libre, próximos pagos, distribución, ¿puedo gastar? (022, ADR-0005) | VERIFIED | Reminder delivery needs a provider |
| Conversational onboarding, Preguntar, camera, AI entitlements (023, ADR-0006) | VERIFIED with fixture provider | Real provider NOT VERIFIED (needs key) |
| Observed vs planned: income links, observed amounts, timeline, camera in Preguntar, undo/forget (024, ADR-0007) | VERIFIED | — |
| Decisions + learning trail, what-if, payoff comparison, preference, question by impact, tap performance (025, ADR-0008) | VERIFIED | Tap feel on a real phone (PO) |
| Recurrence lifecycle: pause / resume / end, edit history, per-income controls (026, ADR-0010) | VERIFIED | — |
| Received ↔ expected income E2E: link moves horizon, dismiss keeps data, tie → choose, PEN/USD apart, no auto-link, idempotent, A/B (027) | VERIFIED | — |
| Skip an occurrence ('No lo pago'), what-if panel (retraso / abono), payoff simulator by monthly amount (028) | VERIFIED | — |
| Camera read idempotency: same photos on an open proposal reuse it (no second charge; SHA-256 key, never the image; re-validated) (029) | VERIFIED (fixture provider) | Resilience verified with a scripted provider (timeout → 1 retry, 5xx cap 2, 4xx → fallback only, invalid output never retried, quota before call, postJson status map, bad files refused); real provider NOT VERIFIED (key) |
| Vels: floating bubble + panel on every /app screen, full page (route /app/preguntar), contextual openers, card operating limit, organize block, minimum vs total, 'le debo X' → pending debt (confirm), estimated basics (030, ADR-0011) | VERIFIED | — |
| Idempotent creates: DB-unique `client_ref` on debts/payments/incomes/accounts; forms, Vels, camera, onboarding (032, ADR-0012) | VERIFIED | — |
| Aplicar plan: saved reservations per currency (supersede / quitar / history), paid only via real settlements, stale-tab guard, Vels confirm (033, ADR-0013) | VERIFIED | — |
| Card statements: billed / minimum / due / used, post-cut from real purchases, usable = min(plan, bank room), minimum-only carry + interest; Tarjetas + Vels (034, ADR-0014) | VERIFIED | Camera read of statements (key) |
| Month-end bug: 'cuota vence pronto' now sees the first days of next month (was silent on the 29–31) (035) | VERIFIED | — |
| E2E harness: insert-only seed under a run id (no collisions, no cleanup dependency), exact-namespace guarded cleanup, harness DB test (036) | VERIFIED | Real-project cleanup blocked: the MCP connector does not run DELETE (see runbook incident); 61 synthetic users pending (3 runs) |
| Resumen redesign: Dinero libre first + bar (pagos/reservado/libre), state chip, 'Lo que viene' to next income, month as context (037) | VERIFIED | PO walkthrough on a phone |
| UX writing pass (ux-writing skill): real plurals (no "(s)"), one date format ("28 set"), errors say what to do (no "inválido"), one save error, shorter help/success texts, "Ver pagos", chat typing label (038) | VERIFIED | Vels/onboarding answers kept (already short and test-pinned) |
| Premium polish: CSS motion system (tokens, route + loading→content entry, sheet/panel exit via allow-discrete, feedback/result entry, bar reveal, hover only on hover devices, tiered reduced motion), Manrope WOFF2 subset via next/font (CLS 0.18→0, font 67→24 KB), Vels chat lazy-loaded, Resumen skeleton mirrors layout (039) | VERIFIED | No exit page transitions (by design: no Next internals, no added latency); PO feel check on a phone |
| OpenRouter provider (OPENROUTER_API_KEY / OPENROUTER_MODEL=openrouter/free / APP_URL) + generic `generateAIResponse` (lib/ai.ts, same quota door) + test route POST /api/ai/chat and page /app/prueba-ia (auth, same-origin JSON, `message` ≤ 1000, off on production unless AI_TEST_ENDPOINT=1); unpriced models refused (040) | IMPLEMENTED · unit VERIFIED | Real call NOT VERIFIED (key not in this environment); Vels/onboarding use it only with AI_PROVIDER=openrouter (PO privacy decision: free routes may log prompts) |
| Vels card cycle: statement/payment days + bank limit per credit card (Tarjetas → Ciclo); Vels says when billed is due and when today's purchase is paid (031) | VERIFIED | Statement camera read needs the AI provider (key) |

## Blockers / decisions (external)
- AI provider (DeepSeek and/or Gemini) + server key → then `scripts/ai-bench.ts` against the local baseline (synthetic data only).
- Email Bridge real integration; billing provider/price/periodicity; custom SMTP before launch; leaked-password protection (plan).
- Known test debt: `analysis-dashboard` and `planning-account` (budget, milestone, alerts) use fixtures pinned to September 2026 (suite header: "Assumes the Lima date is 2026-09-27..30"); since October they fail on dates, not on the product. Fix: date-relative fixtures.
- Known debt: user-owned categories; direct-edit policy for cards/accounts/budgets/debts (ADR-0003); plan limits enforcement.

## Next work (no external decision needed)
1. Partial payments on obligations and sinking funds (named reserves) in the planning engine.
2. Copy pass on older screens (Reglas, Conexiones, Importar); camera failure-state UX once a provider key exists.

PO manual checklist: `docs/runbooks/acceptance-checklist.md`.
