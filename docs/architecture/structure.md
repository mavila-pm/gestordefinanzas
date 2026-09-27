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
app/                 Next.js 16 App Router: public + (auth) pages, /auth/confirm, /app dashboard
lib/supabase/        SSR clients (server.ts, proxy.ts); proxy.ts at root guards /app/*
components/          Client components (forms)
src/web/             Pure helpers for the web layer (validation, Lima month range)
docs/                product/ (binding spec), architecture/, decisions/ (ADRs), security/, runbooks/
```

Dependency direction: `app -> engine -> ingestion -> domain`. `domain` imports nothing.
Swapping a synthetic template for a real one touches only `adapters/<bank>/` and `samples/`.
