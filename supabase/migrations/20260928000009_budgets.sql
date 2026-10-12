-- TASK-010: monthly spending limit per category (spec §42 category milestone, §46 "presupuesto excedido").
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category_id uuid not null references public.categories (id),
  currency public.currency_code not null default 'PEN',
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, category_id, currency)
);
create index budgets_user on public.budgets (user_id);
create index budgets_category on public.budgets (category_id);
alter table public.budgets enable row level security;
create trigger budgets_touch before update on public.budgets for each row execute function public.touch_updated_at();

-- User configuration (not financial facts): own rows only, category must be global or own.
revoke all on public.budgets from anon, authenticated;
grant select, insert, update, delete on public.budgets to authenticated;
grant all on public.budgets to service_role;
create policy budgets_own on public.budgets for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.categories c where c.id = category_id and (c.user_id is null or c.user_id = (select auth.uid()))));
