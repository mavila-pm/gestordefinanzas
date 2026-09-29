-- Cash-flow planning (ADR-0005): obligations, expected incomes, declared balances, settlements, planning settings.
-- Domain: fixed_expenses IS the recurring obligation template (evolved, not duplicated). Future occurrences are
-- computed, never stored; only an occurrence that was actually paid (or received) is recorded, linked to the REAL
-- transaction. Expected money is never added to a balance and a planned payment is never an expense.

-- ── Obligations: evolve fixed_expenses ─────────────────────────────────────────────────────────────────
alter table public.fixed_expenses
  add column kind text not null default 'other'
    check (kind in ('rent', 'car', 'loan', 'card', 'internet', 'phone', 'insurance', 'education', 'services', 'taxes', 'subscription', 'other')),
  add column amount_status text not null default 'confirmed' check (amount_status in ('confirmed', 'estimated', 'unknown')),
  add column frequency text not null default 'monthly' check (frequency in ('monthly', 'bimonthly', 'quarterly', 'yearly')),
  -- For non-monthly obligations: month (1-12) of one due occurrence; monthly ignores it.
  add column anchor_month smallint check (anchor_month between 1 and 12),
  -- Uncertain due date: due_day..due_day_max ("9-10 aprox."). due_day null = date unknown.
  add column due_day_max smallint check (due_day_max between 1 and 31),
  add column target_day smallint check (target_day between 1 and 31),
  add column notes text check (char_length(notes) <= 120),
  add column updated_at timestamptz not null default now();
alter table public.fixed_expenses alter column amount_minor drop not null;
alter table public.fixed_expenses alter column due_day drop not null;
alter table public.fixed_expenses add constraint fixed_expenses_amount_known
  check ((amount_status = 'unknown') = (amount_minor is null));
alter table public.fixed_expenses add constraint fixed_expenses_window
  check (due_day_max is null or (due_day is not null and due_day_max > due_day and due_day_max - due_day <= 7));
alter table public.fixed_expenses add constraint fixed_expenses_anchor
  check (frequency = 'monthly' or anchor_month is not null);

-- Debts: remember the last registered payment so this month's installment is not reserved twice.
alter table public.debts add column last_payment_on date;

-- ── Expected incomes (never money until a real transaction is confirmed) ───────────────────────────────
create table public.expected_incomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  currency public.currency_code not null default 'PEN',
  amount_minor bigint check (amount_minor between 1 and 100000000000),
  amount_status text not null default 'estimated' check (amount_status in ('confirmed', 'estimated', 'unknown')),
  frequency text not null default 'monthly' check (frequency in ('monthly', 'semimonthly', 'biweekly', 'weekly')),
  -- monthly: day_of_month (+ optional day_max window); semimonthly: day_of_month and second_day;
  -- biweekly / weekly: anchor_date (a known pay date).
  day_of_month smallint check (day_of_month between 1 and 31),
  day_max smallint check (day_max between 1 and 31),
  second_day smallint check (second_day between 1 and 31),
  anchor_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check ((amount_status = 'unknown') = (amount_minor is null)),
  check (day_max is null or (day_of_month is not null and day_max > day_of_month and day_max - day_of_month <= 7)),
  check (case frequency when 'monthly' then day_of_month is not null
                        when 'semimonthly' then day_of_month is not null and second_day is not null and second_day <> day_of_month
                        else anchor_date is not null end)
);
create index expected_incomes_user on public.expected_incomes (user_id);

-- ── Declared balance (what the person says they have, with its date) ───────────────────────────────────
create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  currency public.currency_code not null,
  amount_minor bigint not null check (amount_minor between -100000000000 and 100000000000),
  as_of timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index balance_snapshots_user_time on public.balance_snapshots (user_id, currency, as_of desc);

-- ── Settlements: an occurrence that really happened, linked to the real transaction ────────────────────
create table public.plan_settlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  fixed_expense_id uuid,
  expected_income_id uuid,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$'),
  transaction_id uuid,
  status text not null default 'paid' check (status in ('paid', 'skipped')),
  -- "Mantener referencia anterior": the person saw a different real amount and kept the expected one.
  variance_ack boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check ((fixed_expense_id is null) <> (expected_income_id is null)),
  check (status = 'skipped' or transaction_id is not null),
  foreign key (fixed_expense_id, user_id) references public.fixed_expenses (id, user_id) on delete cascade,
  foreign key (expected_income_id, user_id) references public.expected_incomes (id, user_id) on delete cascade,
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete cascade
);
create unique index plan_settlements_obligation_period on public.plan_settlements (fixed_expense_id, period) where fixed_expense_id is not null;
create unique index plan_settlements_income_period on public.plan_settlements (expected_income_id, period) where expected_income_id is not null;
-- One real movement settles at most one planned item: no double counting through two settlements.
create unique index plan_settlements_transaction on public.plan_settlements (transaction_id) where transaction_id is not null;
create index plan_settlements_user on public.plan_settlements (user_id);

-- ── Planning settings (per currency) ──────────────────────────────────────────────────────────────────
create table public.planning_settings (
  user_id uuid not null references auth.users (id) on delete cascade,
  currency public.currency_code not null,
  -- Explicit user decision; never inferred from categories.
  essentials_monthly_minor bigint check (essentials_monthly_minor between 0 and 100000000000),
  cushion_minor bigint not null default 0 check (cushion_minor between 0 and 100000000000),
  updated_at timestamptz not null default now(),
  primary key (user_id, currency)
);

-- ── RLS: own rows only (same model as fixed_expenses / debts) ──────────────────────────────────────────
alter table public.expected_incomes enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.plan_settlements enable row level security;
alter table public.planning_settings enable row level security;
revoke all on public.expected_incomes, public.balance_snapshots, public.plan_settlements, public.planning_settings from anon, authenticated;
grant select, insert, update, delete on public.expected_incomes, public.plan_settlements, public.planning_settings to authenticated;
-- Balances are append-only history: a correction is a new snapshot.
grant select, insert on public.balance_snapshots to authenticated;
create policy expected_incomes_own on public.expected_incomes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy balance_snapshots_own on public.balance_snapshots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy plan_settlements_own on public.plan_settlements for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy planning_settings_own on public.planning_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
