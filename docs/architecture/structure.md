# Repository structure (map for humans and agents)

```
src/
  domain/            Pure types and rules: money, transaction model, financial_effect. No I/O.
  ingestion/
    sources/         FinancialEventSource: provider payload -> RawFinancialEvent (validation only)
    adapters/<bank>/ BankAdapter per bank/channel/version: RawFinancialEvent -> NormalizedFinancialEvent
    adapter-registry.ts   The only place that lists banks
  engine/            Dedupe, categorization, confidence, manual entry, calculations
                     Persistence via TransactionRepository port
  infrastructure/postgres/  PgTransactionRepository (server-side, explicit user_id filters)
tests/
  fixtures/bcp/      SYNTHETIC_FIXTURE builders + samples/ (golden, REAL_ANONYMIZED or SYNTHETIC)
supabase/migrations/ Versioned SQL schema + RLS (supabase/tests/: local-only shim)
scripts/test-db.sh   Throwaway PostgreSQL for DB tests
  ai/                Interpreter, prompts, draft (onboarding memory), assistant intents, providers/ (gemini via
                     @google/genai, fixture), vels-route (Gemini → engine intent), config (env → provider), pricing, sanitize, entitlements
  web/               Pure helpers for the web layer (form validation, Lima dates, labels, CSV, AI test input)
app/                 Next.js 16 App Router. Public: /, (auth)/{login,signup,forgot-password,reset-password}, /auth/confirm.
                     /bienvenida = onboarding (app/app/layout.tsx redirects there until it is completed).
                     /app/* = product: (home) Resumen, movimientos (list, [id], nuevo), revisar, plan, preguntar (Vels),
                     analisis, presupuestos, compromisos, tarjetas, reglas, conexiones, importar, cuenta, ajustes, mas,
                     exportar (CSV route), prueba-ia (temporary AI test). Writes: app/app/actions.ts, app/app/plan/actions.ts,
                     app/app/preguntar/actions.ts, app/bienvenida/actions.ts, app/auth/actions.ts.
                     API: app/api/inbound/email (webhook), app/api/ai/chat (AI test).
proxy.ts             Root proxy: refreshes the session cookie, guards /app/* and /bienvenida (lib/supabase/proxy.ts)
lib/                 Server-only. supabase/ (SSR clients, authUser), queries.ts (reads under RLS), planning.ts
                     (loads + runs the planning engine), ai.ts (ONLY door to AI providers: quota → provider → record),
                     assistant.ts (Vels), onboarding.ts, cards.ts, learning.ts, plan-applications.ts, idempotency.ts,
                     env.ts (public env + site URL), server-db.ts (privileged pool, webhooks only)
components/          React components (forms, chat, sheets, tx rows); components/ui/ = design system (icon, logo,
                     sheet, nav, theme). Copy/visual rules: .claude/rules/frontend.md
docs/                product/ (binding spec), architecture/, decisions/ (ADRs), security/, runbooks/, status.md, MVP.md
```

Dependency direction: `app -> lib -> engine/ai -> ingestion -> domain`. `domain` imports nothing; `src/` never imports
`lib/` or `app/` (pure, unit-testable). Request flow: page (server component) reads via `lib/` under the user's RLS session
→ form → server action validates with `src/web/*-input.ts` → SQL function / RLS write → `revalidatePath`.
Swapping a synthetic template for a real one touches only `adapters/<bank>/` and `samples/`.

## Code / test / migration map (where to look first)
| Area | Code | Tests |
|---|---|---|
| Money, transaction model, `financialEffect()` | `src/domain/` | `money`, `financial-model` |
| Plans / entitlements | `src/domain/entitlements.ts` | `entitlements`, `db/plans` |
| Bank parsers (per bank/channel/version) | `src/ingestion/adapters/` | `bcp-adapters`, `bcp-samples`, `sources` |
| Ingestion, dedupe L1/L1b/L2/L3, import | `src/engine/ingest.ts` | `ingest-pipeline`, `import-pipeline`, `db/import`, `db/pg-repository` |
| Analysis, insights, alerts, data health, budgets, commitments | `src/engine/*.ts` | `analysis`, `insights`, `user-context` |
| Form/input validation (server-side) | `src/web/` | `transaction-input`, `web-auth-input`, `password-reset`, `site-url` |
| Email Bridge webhook | `src/infrastructure/inbound/`, `app/api/inbound/email/` | `email-webhook`, `db/email-bridge` |
| Persistence | `src/infrastructure/{postgres,supabase}/`, `lib/queries.ts`, `app/app/actions.ts` | `db/*` |
| RLS / privileges / A-B isolation guard | `supabase/migrations/` | `db/rls` (must stay green), `db/secure-writes` |
| Splits (Dividir gasto) | `src/domain/allocations.ts`, `components/split-editor.tsx`, `set_transaction_split` | `splits`, `db/splits`, E2E `splits` |
| Conversational onboarding, Preguntar, AI entitlements (ADR-0006) | `src/ai/*`, `lib/ai.ts`, `lib/onboarding.ts`, `lib/assistant.ts`, `app/bienvenida/`, `app/app/preguntar/`, `components/chat.tsx` | `ai-interpreter`, `ai-core`, `db/ai`, E2E `onboarding`, `scripts/ai-bench.ts` |
| Cash-flow planning (ADR-0005) | `src/engine/planning.ts`, `lib/planning.ts`, `app/app/plan/`, `src/web/planning-input.ts` | `planning`, `db/planning`, E2E `cashflow` |
| Profile names (presentation only) | `src/domain/profile.ts`, `components/profile-fields.tsx` | `profile` |
| Design system / shell | `app/globals.css`, `components/ui/*`, `components/tx-row.tsx`, `src/web/labels.ts` | E2E `visual` |
| Observed vs planned, recurrence, scenarios, applied plans, card statements (ADR-0007/0008/0010/0013/0014) | `src/engine/{observed,recurring,scenarios,applied,cards}.ts`, `lib/{plan-applications,cards}.ts` | `observed`, `recurring`, `scenarios`, `applied`, `cards`, `db/*`, E2E `income-link` |
| Vels (ADR-0011) | `src/ai/assistant.ts` (deterministic intents), `lib/assistant.ts`, `components/vels.tsx`, `components/chat.tsx` | `ai-core`, E2E `vels` |
| AI provider: Gemini only (ADR-0015) | `src/ai/config.ts`, `src/ai/providers/gemini.ts` (@google/genai), `src/ai/vels-route.ts`, `lib/ai.ts` (`infer`), `app/api/ai/chat/` | `ai-gemini`, `ai-resilience`, `ai-core` |
| E2E (real Supabase) | `scripts/e2e.sh`, `tests/e2e/{lib.ts,seed.sql,cleanup.sql}` | 10 suites + `visual` + `perf` |
| CI | `.github/workflows/ci.yml` | `check` + `test:db` + `build` per push/PR |

Migrations: `000001` core · `002` RLS hardening · `003` RLS perf · `004` secure writes (app_writer) · `005` accounts,
rules, learning · `006-007` import channel + write path · `008` email bridge · `009` budgets · `010` commitments ·
`011` plans/entitlements · `012` reported values (dedupe after corrections) · `013` card auto-link · `014` transaction allocations (splits) · `015` split stale errcode · `016` profile names · `017` cash-flow planning · `018` AI onboarding, usage and entitlements · `019` learning decisions · `020` planning preferences · `021` recurrence lifecycle · `022` review queue index · `023` essentials status · `024` idempotent creates · `025` plan applications · `026` card statements · `027` replay hardening. Applied list: `docs/runbooks/supabase-migrations.md`.
