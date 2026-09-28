# Task status log

States: IMPLEMENTED (code exists) / VERIFIED (reproducible evidence) / PARTIALLY VERIFIED / BLOCKED / NOT VERIFIED / APPROVED.
Real project: Supabase `jeloegnvaxlfqjntbbyy`. Evidence runs: `docs/runbooks/e2e.md`.

| Task | State | Evidence | Pending |
|---|---|---|---|
| TASK-003 Auth + RLS dashboard | **VERIFIED** · manual PARTIAL · NOT APPROVED | E2E 13/13 (latest regression 2026-09-28); PO manual via Preview: signup, confirmation email, Vercel callback, /app, logout, login PASS | Manual recovery + password change (Supabase built-in SMTP hourly cap). Anti-enumeration on 429 for recovery and signup: fixed + tested |
| TASK-004 Review queue, manual entry, secure writes | **APPROVED** (PO) | E2E 46/46 (re-run 2026-09-28) | PO browser walkthrough (checklist) |
| TASK-005 Own accounts, learning from corrections, manual deletion | **VERIFIED** | Migration 000005; DB tests; E2E 27/27 (with TASK-006) | — |
| TASK-006 Import pasted bank notifications (real pipeline) | **VERIFIED** (import path) | Migrations 000006-7; unit + DB tests; E2E 27/27. Parsers remain SYNTHETIC_UNVERIFIED | Real BCP samples to verify templates |
| TASK-007 Movements (filters/search), analysis, CSV export | **VERIFIED** | unit tests; E2E 26/26 (with TASK-008) | — |
| TASK-008 Milestones, main insight, alerts, data health, settings | **VERIFIED** | unit tests; E2E 26/26 | — |
| TASK-009 Email Bridge foundation (address, signed webhook, replay) | **PARTIALLY VERIFIED** · real integration **BLOCKED** | Migration 000008; unit + DB tests (local pipeline end-to-end); E2E: UI + 503 when unconfigured | PO: inbound provider, domain, server secrets (`docs/architecture/email-bridge.md`) |
| TASK-010 Budgets per category | **VERIFIED** | Migration 000009; unit + DB tests; E2E 18/18 (with 011/012) | — |
| TASK-011 Fixed expenses, debts, monthly commitments | **VERIFIED** | Migration 000010; unit + DB tests; E2E 18/18 | — |
| TASK-012 Plans, trial, server-side entitlements | **VERIFIED** (limits shown, not enforced by PO decision) | Migration 000011; unit + DB tests; E2E 18/18 | Billing provider, price (PO); decide when to enforce limits |
| TASK-013 Dedupe after user corrections | **VERIFIED** | Migration 000012; DB test fails on the old query, passes now | — |
| INFRA E2E optimization (orchestrator, shared helpers, idempotent seed) | **VERIFIED** | `scripts/e2e.sh`; regression 130/130 before the new features | Optional `E2E_DB_URL` (DB password = secret, PO) would let the script seed/clean by itself |
| TASK-014 Automatic card link (ingestion + card registration) | **VERIFIED** | Migration 000013; DB tests incl. A/B + privileged path (mutation-checked); E2E | — |
| TASK-015 Recovery links always end on the password form | **VERIFIED** (code) | unit tests; `token_hash` handling already in `/auth/confirm` | PO: paste the `token_hash` templates in Supabase Auth (manual setting, `docs/architecture/auth.md`) |
| TASK-016 Recurring spending suggestions (Plus) | **VERIFIED** | unit tests; E2E Free teaser / Plus detection / accept as fixed expense | Thresholds (3 months, ±15 %, ±6 days) are PROPUESTOS |
| TASK-017 Search by amount | **VERIFIED** | unit tests; E2E incl. filter-injection attempt | — |
| TASK-018 Sync history (plain language) | **VERIFIED** | unit tests; E2E | — |

## Backlog (known debt)
| Item | Origin | Note |
|---|---|---|
| Custom SMTP | TASK-003, §78/§86 | Built-in SMTP hourly cap; required before public launch |
| Email templates with `token_hash` | TASK-003/015 | Code ready; PO pastes the templates in Supabase Auth (manual). Until then links work only in the browser that started the flow |
| Direct-edit policy for cards/accounts/categories/budgets/debts | ADR-0003 | Client-writable under RLS (own rows, validated); functions optional |
| User-owned categories in rules/budgets | TASK-005/010 | Rules and budgets use the global catalog; no UI for custom categories |
| Leaked password protection (Auth) | Supabase advisor | PO setting (may require paid plan) |
| Plan limits enforcement | §81, PO | Computed and shown; not enforced during beta |

## External blockers / decisions
- Email Bridge real: inbound provider, domain + MX, server env `INBOUND_EMAIL_SECRET`, `DATABASE_URL`, `INGEST_EMAIL_DOMAIN`.
- Billing: provider, price and periodicity (§78). Trial 14 days is PROPUESTO (§77) and configurable (`plan_config`).
- Gmail OAuth, Android SMS app: not started (post-beta per §53).

## FINAL MANUAL ACCEPTANCE CHECKLIST (run on the Preview when ready)
- [ ] TASK-003: password recovery email → `/reset-password` → change password → login with the new one; old one rejected.
- [ ] TASK-004: "Por revisar" queue, correct a movement, manual entry, register a card.
- [ ] TASK-005: register an own account (with 4 digits) and a card; correct a category with "Recordar"; see it in Reglas.
- [ ] TASK-006: paste a REAL BCP SMS/email (Importar); check type, amount, card, merchant; paste it again (no duplicate).
      Share an anonymized copy if a field is wrong (it improves the parsers).
- [ ] TASK-007: Movimientos filters/search; Análisis month vs previous; export CSV and open it in Excel.
- [ ] TASK-008: set your name in Ajustes; dashboard health/alerts/insight read naturally.
- [ ] TASK-009: generate your private address in Conexiones (not usable until provider/domain).
- [ ] TASK-010/011: create a budget, a fixed expense and a debt; register a debt payment.
- [ ] TASK-012: Cuenta shows Free; start the Plus trial and check the end date.

## Compact report format (phase close)
```
FASE <n> · <fecha> · rama <x> · commits <a..b>
| TASK | Qué | Estado | Evidencia |
TESTS      unit n/n · DB n/n · build OK · E2E n/n (suites)
DB         migraciones aplicadas + verificación (1 línea)
SEGURIDAD  cambios relevantes (≤5)
BLOQUEOS / DECISIONES  numeradas, con impacto
RIESGOS    ≤3
NOT VERIFIED  qué y por qué
CHECKLIST MANUAL  → sección de arriba
TOKEN AUDIT  total · presupuesto · desvío · causa principal
```
