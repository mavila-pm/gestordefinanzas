# ADR-0003 — Sensitive transaction writes go through audited database functions

**Status:** APPROVED by Mauro (Product Owner) · applied to `jeloegnvaxlfqjntbbyy` on 2026-09-27 (migration 000004)

## Context
Until TASK-003, authenticated users could INSERT/UPDATE/DELETE their own `transactions` directly with the Supabase
client, including `status`, `confidence` and `direction` (accepted debt in `docs/security/rls.md`). With Supabase,
anything a server action does with the user's JWT, the browser can also do with the same JWT and the public key,
so "only via server actions" cannot be enforced by the web layer alone.

## Decision
1. `authenticated` keeps SELECT only on `transactions`; INSERT/UPDATE/DELETE are revoked.
2. The only write paths are three functions: `create_manual_transaction`, `review_transaction` (confirm/ignore)
   and `correct_transaction`. They validate identity, ownership, enums, amounts, dates, description, and that
   category/card/account belong to the caller; `direction` is always derived from `type`.
3. They are SECURITY DEFINER but owned by `app_writer`: NOLOGIN, **no BYPASSRLS**, not the table owner. RLS
   policies for `app_writer` use the caller's JWT, so RLS remains a second barrier inside the functions.
   (A definer owned by `postgres` would bypass RLS: on Supabase `postgres` has BYPASSRLS.)
4. Provenance is append-only: the functions never modify `transaction_sources`/`financial_events` or the
   `fingerprint`; `app_writer` can only add `manual` sources. Every change writes `audit_events` with from/to values.
5. Next.js server actions are the first layer (session + payload validation, friendly errors); the database
   functions are the authoritative layer; RLS + composite FKs are the last one. The service role is not used.

## Consequences
- The Supabase linter may warn "SECURITY DEFINER function executable by authenticated" (0029): intended and
  documented; each function authorizes internally and runs under a non-bypass role.
- Ingestion keeps writing server-side with a privileged connection (unchanged).
- Transaction deletion is not offered; "Ignorar" excludes a movement without destroying it.
- Cards/accounts/categories stay client-writable under RLS (own rows only); moving them behind functions is
  optional hardening, not required by the spec.
