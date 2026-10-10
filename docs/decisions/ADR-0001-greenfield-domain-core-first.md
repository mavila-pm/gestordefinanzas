# ADR-0001 — Greenfield repo: framework-agnostic TypeScript domain core first

**Status:** ACCEPTED (technical, reversible) · 2026-09-27

## Context
- The repository contained only `README.md` (commit `28345a3`).
- Confirmed by Mauro (2026-09-27): **NEW PROJECT / GREENFIELD**. No prior prototype exists; MOTHER_DOCUMENT
  §55 (prototype audit) does not apply. The Prompt Madre v1.1 remains the binding spec.
- The preferred stack (Next.js + Supabase + Vercel) is PROPOSED (§77), not yet confirmed.
- The first demonstrable objective (§72) is the BCP vertical slice; its correctness rules (money,
  dedupe, card payment, refunds) do not depend on a web framework.

## Decision
1. Build the ingestion + financial engine as plain TypeScript (`src/domain`, `src/ingestion`, `src/engine`)
   with no dependency on Next.js, Supabase, Gmail or any provider.
2. Persistence goes through the `TransactionRepository` port. An in-memory implementation backs unit tests;
   PostgreSQL (Supabase) implements the same port next.
3. Money is integer minor units (`amountMinor`), always positive; `type` + `direction` give meaning.
   PostgreSQL will store `bigint` minor units (or `numeric(14,2)`; decided in the schema task).
4. Test runner: Vitest. Package manager: npm.

## Consequences
- The Next.js app can be scaffolded later around this core without rewriting rules.
- If the prototype appears later, it is audited (KEEP/REFACTOR/REPLACE/REMOVE) against this core.
