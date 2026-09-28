# Status — current state (not a diary; history lives in git + ADRs)

States: IMPLEMENTED · VERIFIED (reproducible evidence at the level `docs/qa.md` requires) · APPROVED (PO).
Branch `claude/beautiful-keller-ikxlrj` (PR mavila-pm/gestordefinanzas#1, Vercel Preview per push). Supabase `jeloegnvaxlfqjntbbyy`,
migrations applied through `20260928000021`.

## Checkpoint (2026-09-28)
Last full regression: unit 271 · DB 94 · E2E 231/231 on clean seeds · perf probe 8/8 (tap feedback < 40 ms) · cleanup 0|0.
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

## Blockers / decisions (external)
- AI provider (DeepSeek and/or Gemini) + server key → then `scripts/ai-bench.ts` against the local baseline (synthetic data only).
- Email Bridge real integration; billing provider/price/periodicity; custom SMTP before launch; leaked-password protection (plan).
- Known debt: user-owned categories; direct-edit policy for cards/accounts/budgets/debts (ADR-0003); plan limits enforcement.

## Next work (no external decision needed)
1. Camera: retry + failure states UX; copy pass on screens not touched since TASK-021.

PO manual checklist: `docs/runbooks/acceptance-checklist.md`.
