# Repository structure (greenfield)

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
app/                 Next.js 16 App Router: public + (auth) pages, /auth/confirm, /app dashboard,
                     /app/revisar (review queue), /app/movimientos/[id] (correct + origin + history),
                     /app/movimientos/nuevo (manual entry), /app/tarjetas; app/app/actions.ts = server write layer
lib/supabase/        SSR clients (server.ts, proxy.ts); proxy.ts at root guards /app/*
components/          Client components (forms)
src/web/             Pure helpers for the web layer (auth + transaction form validation, Lima dates)
lib/queries.ts       Server-side reads under the user's session (RLS)
docs/                product/ (binding spec), architecture/, decisions/ (ADRs), security/, runbooks/
```

Dependency direction: `app -> engine -> ingestion -> domain`. `domain` imports nothing.
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
| Profile names (presentation only) | `src/domain/profile.ts`, `components/profile-fields.tsx` | `profile` |
| Design system / shell | `app/globals.css`, `components/ui/*`, `components/tx-row.tsx`, `src/web/labels.ts` | E2E `visual` |
| E2E (real Supabase) | `scripts/e2e.sh`, `tests/e2e/{lib.ts,seed.sql,cleanup.sql}` | 6 suites + visual |

Migrations: `000001` core · `002` RLS hardening · `003` RLS perf · `004` secure writes (app_writer) · `005` accounts,
rules, learning · `006-007` import channel + write path · `008` email bridge · `009` budgets · `010` commitments ·
`011` plans/entitlements · `012` reported values (dedupe after corrections) · `013` card auto-link · `014` transaction allocations (splits) · `015` split stale errcode · `016` profile names. Applied list: `docs/runbooks/supabase-migrations.md`.
