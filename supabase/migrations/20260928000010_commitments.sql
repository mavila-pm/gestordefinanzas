-- TASK-011: fixed expenses (spec §47) and debts (spec §48). User-entered commitments; they never create
-- transactions (the real payment arrives as a movement), so nothing is double counted.
create table public.fixed_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  category_id uuid references public.categories (id),
  currency public.currency_code not null default 'PEN',
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  due_day smallint not null check (due_day between 1 and 31),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index fixed_expenses_user on public.fixed_expenses (user_id);
create index fixed_expenses_category on public.fixed_expenses (category_id);

create table public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  lender text check (char_length(lender) <= 60),
  currency public.currency_code not null default 'PEN',
  principal_minor bigint not null check (principal_minor between 1 and 100000000000),
  balance_minor bigint not null check (balance_minor between 0 and 100000000000),
  -- Annual rate in basis points (12.50% = 1250); optional.
  annual_rate_bp integer check (annual_rate_bp between 0 and 100000),
  installment_minor bigint check (installment_minor between 1 and 100000000000),
  installments_total integer check (installments_total between 1 and 600),
  installments_paid integer not null default 0 check (installments_paid >= 0),
  due_day smallint check (due_day between 1 and 31),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (installments_total is null or installments_paid <= installments_total)
);
create index debts_user on public.debts (user_id);
create trigger debts_touch before update on public.debts for each row execute function public.touch_updated_at();

alter table public.fixed_expenses enable row level security;
alter table public.debts enable row level security;
revoke all on public.fixed_expenses, public.debts from anon, authenticated;
grant select, insert, update, delete on public.fixed_expenses, public.debts to authenticated;
grant all on public.fixed_expenses, public.debts to service_role;
create policy fixed_expenses_own on public.fixed_expenses for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (category_id is null or exists (
    select 1 from public.categories c where c.id = category_id and (c.user_id is null or c.user_id = (select auth.uid())))));
create policy debts_own on public.debts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
