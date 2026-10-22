# ADR-0014 — Card statements and card position

Status: ACCEPTED · Date: 2026-09-29 · Migration 000026 (applied).

- `card_statements` (one per card + cut date): cut date, due date, total facturado, pago mínimo, utilizado hoy
  (optional, with its timestamp), source (manual / camera / import), status (confirmed / estimated), updated_at.
  Unknown amounts stay null (never 0); "0" typed by the person is a real zero. Currency must be its credit card's
  (trigger); minimum ≤ total; due within 62 days after the cut. RLS own rows + composite FK to the card; no delete.
- Post-corte is not stored: it is the sum of confirmed card purchases after the cut date (real movements).
- `src/engine/cards.ts` `cardPosition()` keeps apart: línea · utilizado · disponible del banco · facturado (+ due, days
  left) · post-corte (next statement) · mínimo vs total (minimum-only carry + interest when the rate is known) ·
  usable real = min(plan free, bank room). A statement older than the last cut is flagged, not used as current.
- UI: Tarjetas → "Estado" sheet (manual entry; fills cycle days only when missing) + a position summary.
  Vels (`card_limit`, `pay_min`) reads the same position: billed + due, post-cut, real limit ≠ bank line.
- Camera/import of statements: fields and `source` exist; the reader stays behind the AI provider (key pending).
