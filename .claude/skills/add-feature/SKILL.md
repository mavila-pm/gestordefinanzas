---
name: add-feature
description: Recipe to add or extend a Velsuno feature end to end (spec check, migration + DB test, pure engine, server read/write, page, E2E, status). Use when a task adds a screen, a table, a server action, or a new engine rule.
---
# add-feature
Map of modules and their tests: `docs/architecture/structure.md`. Path rules (financial, database, frontend, auth) load
by themselves when you touch those files.

1. **Spec first.** Find the section in `docs/product/MOTHER_DOCUMENT.md` (grep `^## `) and any ADR in `docs/decisions/`.
   If the feature deviates from them → stop: it needs a Change Request (Anexo A). New durable decision → new ADR.
2. **Data** (only if new columns/tables): new file `supabase/migrations/<YYYYMMDDhhmmss>_<name>.sql` — RLS own-row,
   `unique (id, user_id)` + composite FKs, explicit grants (no anon); atomic/idempotent writes as a SQL function
   (pattern: `20260927000004_secure_transaction_writes.sql`, `20260929000024_idempotent_creates.sql`).
   Test in `tests/db/<area>.test.ts` (A/B isolation, forbidden privileges, constraints; helpers in `tests/db/helpers.ts`).
   Run `npm run test:db`; apply to `jeloegnvaxlfqjntbbyy` only after it passes; list it in `docs/runbooks/supabase-migrations.md`.
3. **Logic** in `src/` (pure, no I/O): domain types in `src/domain/`, rules/calculations in `src/engine/`, form
   validation in `src/web/<area>-input.ts`. Money = integer minor units; metrics via `financialEffect()`. Unit test in `tests/<area>.test.ts`.
4. **Server**: reads in `lib/queries.ts` or an area loader (`lib/planning.ts`), always with `createSupabaseServerClient()`
   + `authUser()` (RLS). Writes in `app/app/actions.ts` (or the route's `actions.ts`): validate → RPC/insert → `revalidatePath`.
   Creates take a `client_ref` (ADR-0012, `lib/idempotency.ts`). AI only through `lib/ai.ts`.
5. **UI**: page in `app/app/<route>/page.tsx` (server component), client parts in `components/`; reuse `components/ui/*`
   (Sheet, Icon) and `app/globals.css` tokens. New menu entry → `components/ui/nav-items.ts`. No `loading.tsx` above a `notFound()`.
6. **E2E** when the flow is user-visible: extend a suite in `tests/e2e/` or add one + its probe pair in `tests/e2e/seed.sql`
   (synthetic `e2e-<tag>-<run>@gestordefinanzas.invalid` only; dates relative to Lima today, never fixed).
7. Verify with the `verify` skill (level from `scripts/qa/risk.sh`); money-affecting diff → `financial-safety`;
   auth/RLS/secrets/AI → `security-reviewer` agent. Close with `task-close` (status row in `docs/status.md`, MVP box in `docs/MVP.md`).
