-- UX audit 2026-10-15 (CR-002): Inversiones (manual tracking), Balance financiero goals and the onboarding profile.
-- Additive only: no DROP, every new column is nullable or defaulted. (058 is taken by the AI front's branch.)
--
--   investments          what the person invests in (plazo fijo, fondo mutuo, acciones…): name, kind, currency,
--                        where. Tracking only — Velsuno never quotes prices, ranks or advises (MOTHER §89).
--   investment_entries   append-only: aportes ('contribution'), retiros ('withdrawal') and valorizaciones
--                        ('valuation' = "hoy vale X", what the person reads in their platform). Value is never
--                        invented: without a valuation it is unknown, never "what was contributed".
--   investment_positions contributed = Σ aportes − Σ retiros; last valuation and its date (security_invoker).
--   planning_settings    savings and investment goals as a fixed amount or a % of monthly income (basis points).
--   user_preferences     work_type (dependiente/independiente), has_investments / has_debts (null = not said),
--                        main_goal (what the person wants from the app; qualitative).

create table public.investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60 and regexp_replace(name, '[\s-]', '', 'g') !~ '\d{9}'),
  kind text not null check (kind in ('plazo_fijo', 'fondo_mutuo', 'acciones', 'etf', 'cripto', 'bonos', 'afp_voluntario', 'inmueble', 'negocio', 'otro')),
  currency public.currency_code not null,
  institution text check (char_length(btrim(institution)) between 1 and 40 and regexp_replace(institution, '[\s-]', '', 'g') !~ '\d{5}'),
  -- Optional, informative: the rate or return the person was promised (basis points per year). Never used to compute value.
  annual_rate_bp integer check (annual_rate_bp between 0 and 100000),
  active boolean not null default true,
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index investments_user on public.investments (user_id, created_at);
create unique index investments_client_ref on public.investments (user_id, client_ref) where client_ref is not null;

create table public.investment_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  investment_id uuid not null,
  kind text not null check (kind in ('contribution', 'withdrawal', 'valuation')),
  -- A valuation can be 0 (lost everything); aportes and retiros are always > 0.
  amount_minor bigint not null check (amount_minor between 0 and 100000000000),
  on_date date not null default ((now() at time zone 'America/Lima')::date),
  note text check (char_length(note) <= 80),
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint investment_entries_amount check (kind = 'valuation' or amount_minor > 0),
  constraint investment_entries_investment_fk foreign key (investment_id, user_id) references public.investments (id, user_id) on delete cascade
);
create index investment_entries_investment on public.investment_entries (investment_id, user_id, on_date desc);
create index investment_entries_user on public.investment_entries (user_id);
create unique index investment_entries_client_ref on public.investment_entries (user_id, client_ref) where client_ref is not null;

-- Never more withdrawn than contributed, never on an archived investment; serialized per investment (row lock).
create function public.investment_entries_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_active boolean;
  v_net bigint;
begin
  select i.active into v_active from public.investments i where i.id = new.investment_id and i.user_id = new.user_id for update;
  if not found then return new; end if; -- not the person's investment: the composite FK rejects it
  if not v_active then raise exception 'investment_inactive' using errcode = '23514'; end if;
  if new.kind = 'withdrawal' then
    select coalesce(sum(case e.kind when 'contribution' then e.amount_minor when 'withdrawal' then -e.amount_minor else 0 end), 0)::bigint into v_net
    from public.investment_entries e where e.investment_id = new.investment_id and e.user_id = new.user_id;
    if new.amount_minor > v_net then raise exception 'withdrawal_over_contributed' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke execute on function public.investment_entries_guard() from public, anon, authenticated;
create trigger investment_entries_guard before insert on public.investment_entries
  for each row execute function public.investment_entries_guard();

-- At most 50 active investments per person (the loaders read 50).
create function public.investments_active_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active) then
    perform pg_advisory_xact_lock(hashtextextended('investments_active:' || new.user_id::text, 0));
    if (select count(*) from public.investments i where i.user_id = new.user_id and i.active and i.id <> new.id) >= 50 then
      raise exception 'investment_limit' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.investments_active_cap() from public, anon, authenticated;
create trigger investments_active_cap before insert or update of active on public.investments
  for each row execute function public.investments_active_cap();

create view public.investment_positions with (security_invoker = true) as
  select i.id as investment_id, i.user_id, i.currency, i.active,
    coalesce(sum(case e.kind when 'contribution' then e.amount_minor when 'withdrawal' then -e.amount_minor else 0 end), 0)::bigint as contributed_minor,
    (select v.amount_minor from public.investment_entries v where v.investment_id = i.id and v.user_id = i.user_id and v.kind = 'valuation'
      order by v.on_date desc, v.created_at desc limit 1) as value_minor,
    (select v.on_date from public.investment_entries v where v.investment_id = i.id and v.user_id = i.user_id and v.kind = 'valuation'
      order by v.on_date desc, v.created_at desc limit 1) as value_on
  from public.investments i
  left join public.investment_entries e on e.investment_id = i.id and e.user_id = i.user_id
  group by i.id, i.user_id, i.currency, i.active;

alter table public.investments enable row level security;
alter table public.investment_entries enable row level security;
revoke all on public.investments, public.investment_entries, public.investment_positions from public, anon, authenticated;
grant select, insert on public.investments to authenticated;
grant update (name, institution, annual_rate_bp, active, updated_at) on public.investments to authenticated;
grant select, insert on public.investment_entries to authenticated;
grant select on public.investment_positions to authenticated;
grant all on public.investments, public.investment_entries to service_role;
create policy investments_own on public.investments for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy investment_entries_own on public.investment_entries for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ── Balance financiero goals (per currency, existing own-row RLS of planning_settings) ────────────────────
alter table public.planning_settings
  add column savings_goal_mode text not null default 'fixed' check (savings_goal_mode in ('fixed', 'percent')),
  add column savings_goal_bp integer check (savings_goal_bp between 1 and 10000),
  add column investment_goal_mode text not null default 'fixed' check (investment_goal_mode in ('fixed', 'percent')),
  add column investment_goal_minor bigint check (investment_goal_minor between 1 and 100000000000),
  add column investment_goal_bp integer check (investment_goal_bp between 1 and 10000),
  add column investment_goal_investment_id uuid,
  add constraint planning_settings_savings_percent check (savings_goal_mode = 'fixed' or savings_goal_bp is not null),
  add constraint planning_settings_investment_percent check (investment_goal_mode = 'fixed' or investment_goal_bp is not null),
  add constraint planning_settings_goal_investment_fk foreign key (investment_goal_investment_id, user_id)
    references public.investments (id, user_id) on delete set null (investment_goal_investment_id);
create index planning_settings_goal_investment on public.planning_settings (investment_goal_investment_id, user_id);

-- ── Onboarding profile (Ajustes can change it later) ──────────────────────────────────────────────────────
alter table public.user_preferences
  add column work_type text check (work_type in ('dependent', 'independent')),
  add column has_investments boolean,
  add column has_debts boolean,
  add column main_goal text check (main_goal in ('controlar_gastos', 'ahorrar', 'salir_de_deudas', 'invertir', 'planificar_pagos', 'otro'));
