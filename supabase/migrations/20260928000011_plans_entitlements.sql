-- TASK-012: SaaS foundation (spec §81-85). Plan state per user and server-side configurable limits.
-- Clients can READ their own subscription and the plan config; they can never write their plan. The only client
-- path is start_plus_trial() (once per user, duration from config). Paid plans come from a future BillingProvider.

create table public.plan_config (
  key text primary key check (key ~ '^[a-z_]{3,60}$'),
  value integer not null check (value >= 0),
  note text
);
insert into public.plan_config (key, value, note) values
  ('trial_days', 14, 'PROPUESTO §77/§83: Plus trial length, no card required'),
  ('free_auto_movements_per_month', 50, '§81 initial configurable value'),
  ('free_history_months', 3, '§81 initial configurable value (older data preserved)'),
  ('free_institutions', 1, '§81'),
  ('plus_institutions', 3, '§82 first commercial version');

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'plus')),
  status text not null default 'free' check (status in ('free', 'trialing', 'active', 'past_due', 'canceled')),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  provider text check (provider ~ '^[a-z0-9_]{2,30}$'),
  provider_ref text check (char_length(provider_ref) <= 200),
  updated_at timestamptz not null default now(),
  check (status <> 'trialing' or (plan = 'plus' and trial_ends_at is not null))
);
create trigger subscriptions_touch before update on public.subscriptions for each row execute function public.touch_updated_at();

alter table public.plan_config enable row level security;
alter table public.subscriptions enable row level security;
revoke all on public.plan_config, public.subscriptions from anon, authenticated;
grant select on public.plan_config, public.subscriptions to authenticated;
grant all on public.plan_config, public.subscriptions to service_role;
create policy plan_config_read on public.plan_config for select to authenticated using (true);
create policy subscriptions_read on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));

grant select on public.plan_config to app_writer;
grant select, insert, update on public.subscriptions to app_writer;
create policy plan_config_writer_read on public.plan_config for select to app_writer using (true);
create policy subscriptions_writer on public.subscriptions for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

-- One trial per user, ever. Never charges anything; expiry is evaluated at read time (automatic downgrade, §83).
create function public.start_plus_trial() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_days integer;
  v_sub public.subscriptions%rowtype;
  v_end timestamptz;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_sub from public.subscriptions where user_id = v_uid for update;
  if v_sub.trial_started_at is not null then raise exception 'trial_already_used' using errcode = '22023'; end if;
  if v_sub.status = 'active' then raise exception 'already_plus' using errcode = '22023'; end if;
  select value into v_days from public.plan_config where key = 'trial_days';
  v_end := now() + make_interval(days => coalesce(v_days, 14));
  insert into public.subscriptions (user_id, plan, status, trial_started_at, trial_ends_at)
  values (v_uid, 'plus', 'trialing', now(), v_end)
  on conflict (user_id) do update set plan = 'plus', status = 'trialing', trial_started_at = now(), trial_ends_at = v_end;
  return v_end;
end $$;

grant create on schema public to app_writer;
alter function public.start_plus_trial() owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.start_plus_trial() from public, anon;
grant execute on function public.start_plus_trial() to authenticated;
