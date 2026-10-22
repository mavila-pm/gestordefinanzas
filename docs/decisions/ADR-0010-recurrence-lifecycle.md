# ADR-0010 — Recurrence lifecycle: pause, resume, end (no history rewrite)

Status: ACCEPTED · Date: 2026-09-28 · Migration 000021 (applied).

- `fixed_expenses` and `expected_incomes` get `paused_until` and `ended_on` (dates, nullable).
- Engine: `occurrencesBetween` / `incomeOccurrencesBetween` drop occurrences dated before `paused_until` or after
  `ended_on` (undated occurrences use the period's first day). Everything built on them follows: Dinero libre, timeline,
  payment/income matching, yearly reserves, next income, month commitments.
- Past settlements, real movements and their amounts are never touched. Editing amount/date changes the plan from now on;
  the change is logged in `learning_events` (before/after). "Quitar" (active = false) remains for deleting a plan item.
- UI: Próximos pagos row sheet → Pausar hasta / Reanudar / "Ya no lo pago" + Historial (last 6 real payments);
  Dinero libre → per-income sheet (same controls + Quitar). One form instance toggles pause⇄resume so the sheet closes.
