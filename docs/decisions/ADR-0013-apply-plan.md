# ADR-0013 — "Aplicar plan": saved reservations, never money movement

Status: ACCEPTED · Date: 2026-09-29 · Migration 000025 (applied).

- `plan_applications`: a snapshot of the plan the person saw (per currency): base (saldo or an income that arrived),
  horizon HOY → día antes del próximo ingreso, reserved, free, status (confirmed/partial), lines (kind, label, amount or
  null, date, obligation + period). Checks: `free = base − reserved`, income base ⇔ its movement (composite FK).
- Applying never pays, transfers, creates movements or settlements, or marks obligations paid. "Pagado" is derived at
  read time from `plan_settlements` (the real movement link) for the same obligation + period (`src/engine/applied.ts`).
- Kept apart on screen: Comprometido (pending payments/debts) · Reservado (basics, reserves, cushion) · Pagado (real) ·
  por confirmar (unknown amounts, never 0) · Libre. PEN and USD are separate plans; never summed.
- Concurrency: `apply_plan()` (security invoker, RLS) takes a per-user/currency advisory lock, supersedes the active
  plan and inserts the new one; a unique partial index allows one active per currency; a repeated `client_ref` returns
  the same row. Stale tab: the server recomputes and refuses if free/reserved differ from what the person saw.
- History: append-only (no delete grant; only `status`/`closed_at` updatable, trigger allows only active → superseded /
  cancelled). Edit = apply again (supersede); Quitar = cancelled. Horizon passed → shown as ended, next apply supersedes.
- Vels: "aplica el plan" / "Organiza mi dinero" → proposal card (amounts, "No paga ni mueve dinero") → confirm →
  same `applyPlan` path (one core). Tests: unit `tests/applied.test.ts`, DB `tests/db/plan-applications.test.ts`
  (supersede chain, 5 parallel applies → 1 active, same ref → 1 row, immutability, A/B, anon), E2E cashflow + vels.
