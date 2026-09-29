-- ADR-0010: recurrence lifecycle without rewriting history. A planned item can be paused (its occurrences before
-- `paused_until` are not planned) or ended (no occurrences after `ended_on`). Past settlements and movements stay.
alter table public.fixed_expenses add column paused_until date, add column ended_on date;
alter table public.expected_incomes add column paused_until date, add column ended_on date;
