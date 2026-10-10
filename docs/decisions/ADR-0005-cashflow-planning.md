# ADR-0005 — Cash-flow planning: obligations, next income and "Dinero libre"

Status: Accepted (TASK-022). Date: 2026-09-28.

## Decision
- **One obligation domain.** `fixed_expenses` is the recurring obligation template (evolved: kind, amount status
  confirmed/estimated/unknown, frequency + anchor month, due day with optional window `due_day..due_day_max`, preferred
  payment day, notes). No parallel "recurring_payments" table. Debts with an installment and due day are read as
  obligations too (their monthly installment); `debts.last_payment_on` settles that month.
- **Template vs occurrence.** Future occurrences are computed (pure engine), never stored. Only what really happened is
  recorded in `plan_settlements`, linked to the REAL transaction (one transaction settles at most one planned item;
  one occurrence is settled once). Planned payments are never expenses; the financial engine keeps using transactions.
- **Expected incomes** (`expected_incomes`, several payers, monthly/semimonthly/biweekly/weekly, optional window) only
  close the planning horizon. They are never added to a balance.
- **Balance** is what the person declares (`balance_snapshots`, append-only, with its date). Stale when older than 7
  days or when money moved in the account after it (credit-card purchases excluded).
- **Horizon = today → next expected income** (not end of month). With an income window the plan runs to the last
  possible day and says so. Without a next income or a balance the plan is `incomplete` and shows no free amount.
- **Engine** (`src/engine/planning.ts`): deterministic and explainable. Order: overdue (≤ 31 days) → payments before
  the next income (by preferred day) → debts → essentials (explicit monthly amount, pro-rated by days) → reserves for
  infrequent obligations (proportional, *planned*, not separated money) → cushion. Unknown amounts stay `null` and
  unknown dates are reserved once and listed: the result is labelled **estimado** (`partial`). PEN and USD never mix.
- **Suggestions, never silent automation:** payment matching ("¿Ya pagaste?"), amount changes ("Luz subió S/ 31") with
  update / keep, debt strategies (avalanche needs every rate; snowball by balance; neither is "the best").
- **What-if** ("¿Puedo gastar?") runs in the browser from the plan and never writes.
- **Reminders:** `reminderIntents()` (one main + one last-minute) is an intent only; delivery adapters are future work.
- **Language:** "Dinero libre" / "Dinero libre estimado" in the UI; `safe-to-spend` stays an internal concept.
