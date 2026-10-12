-- Plan selection + checkout (PO 2026-10-12): Mensual US$ 4 (US$ 9 from 2027-01-01, Lima time), Anual US$ 59,
-- Vitalicio US$ 198 (one payment); 14-day trial on Mensual/Anual for people who never had one. Provider: Culqi.
--
-- The price is decided HERE, at order time: the client only names a plan, never an amount. An order is a record of
-- intent; Plus is granted only by billing_activate (server-only, after the provider confirms the charge server to
-- server) or, for demo accounts, simulated without touching the real subscription.

alter table public.subscriptions add column billing_plan text check (billing_plan in ('monthly', 'annual', 'lifetime'));

-- Single source of truth for prices (minor units, USD). Pages read it; orders store what it returned.
create function public.billing_price(p_plan text, p_at timestamptz default now()) returns bigint
language sql stable set search_path = '' as $$
  select case p_plan
    when 'monthly' then case when (p_at at time zone 'America/Lima')::date >= date '2027-01-01' then 900 else 400 end
    when 'annual' then 5900
    when 'lifetime' then 19800
  end::bigint
$$;
revoke execute on function public.billing_price(text, timestamptz) from public, anon;
grant execute on function public.billing_price(text, timestamptz) to authenticated, app_writer, service_role;

create table public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_code text not null check (plan_code in ('monthly', 'annual', 'lifetime')),
  currency public.currency_code not null default 'USD' check (currency = 'USD'),
  amount_minor bigint not null check (amount_minor between 1 and 10000000),
  trial_days smallint not null default 0 check (trial_days between 0 and 60),
  status text not null default 'pending' check (status in ('pending', 'paid', 'trialing', 'failed', 'simulated')),
  provider text check (provider ~ '^[a-z0-9_]{2,30}$'),
  provider_ref text check (char_length(provider_ref) <= 200),
  failure text check (char_length(failure) <= 200),
  terms_accepted_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (id, user_id),
  check (plan_code <> 'lifetime' or trial_days = 0),
  check ((status = 'pending') = (settled_at is null))
);
create index billing_orders_user on public.billing_orders (user_id, created_at desc);
create unique index billing_orders_provider_ref on public.billing_orders (provider, provider_ref) where provider_ref is not null;

alter table public.billing_orders enable row level security;
revoke all on public.billing_orders from anon, authenticated;
grant select on public.billing_orders to authenticated;
grant all on public.billing_orders to service_role;
create policy billing_orders_read on public.billing_orders for select to authenticated using (user_id = (select auth.uid()));
grant select, insert, update on public.billing_orders to app_writer;
create policy billing_orders_writer on public.billing_orders for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

-- Start a purchase: validates the plan, prices it, decides the trial (once per person, never on Vitalicio).
create function public.billing_create_order(p_plan text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_sub public.subscriptions%rowtype;
  v_days integer;
  v_trial integer := 0;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_plan is null or p_plan not in ('monthly', 'annual', 'lifetime') then raise exception 'bad_plan' using errcode = '22023'; end if;
  select * into v_sub from public.subscriptions where user_id = v_uid for update;
  if v_sub.billing_plan = 'lifetime' and v_sub.status = 'active' then raise exception 'already_lifetime' using errcode = '22023'; end if;
  -- A paid plan (or its card-backed trial) is changed from its management, never bought twice.
  if v_sub.billing_plan is not null and v_sub.status in ('active', 'trialing', 'past_due') then raise exception 'already_plus' using errcode = '22023'; end if;
  if (select count(*) from public.billing_orders where user_id = v_uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_orders' using errcode = '22023';
  end if;
  if p_plan <> 'lifetime' and v_sub.trial_started_at is null then
    select value into v_days from public.plan_config where key = 'trial_days';
    v_trial := coalesce(v_days, 14);
  end if;
  insert into public.billing_orders (user_id, plan_code, amount_minor, trial_days, terms_accepted_at)
  values (v_uid, p_plan, public.billing_price(p_plan, now()), v_trial, now())
  returning id into v_id;
  return v_id;
end $$;

-- Demo accounts only: complete the order without any charge. The real subscription is never touched; only the
-- simulated plan (already used by Ajustes → Plan y uso and the AI limits) changes.
create function public.billing_simulate_payment(p_order uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_order public.billing_orders%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.demo_access where user_id = v_uid) then raise exception 'not_demo' using errcode = '42501'; end if;
  select * into v_order from public.billing_orders where id = p_order and user_id = v_uid for update;
  if not found or v_order.status <> 'pending' then raise exception 'order_not_pending' using errcode = '22023'; end if;
  update public.billing_orders set status = 'simulated', provider = 'demo', settled_at = now() where id = p_order;
  update public.demo_access set simulated_plan = case when v_order.trial_days > 0 then 'trial' else 'plus' end where user_id = v_uid;
  return 'simulated';
end $$;

grant create on schema public to app_writer;
alter function public.billing_create_order(text) owner to app_writer;
alter function public.billing_simulate_payment(uuid) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.billing_create_order(text) from public, anon;
revoke execute on function public.billing_simulate_payment(uuid) from public, anon;
grant execute on function public.billing_create_order(text) to authenticated;
grant execute on function public.billing_simulate_payment(uuid) to authenticated;

-- Server only (never a browser success URL): called after the provider confirmed the charge or the card-backed
-- trial server to server. Idempotent per order: a replay with the same reference is a no-op.
create function public.billing_activate(p_order uuid, p_provider text, p_ref text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.billing_orders%rowtype;
  v_trial_end timestamptz;
  v_period_end timestamptz;
begin
  select * into v_order from public.billing_orders where id = p_order for update;
  if not found then raise exception 'order_not_found' using errcode = '22023'; end if;
  if v_order.status in ('paid', 'trialing') then
    if v_order.provider = p_provider and v_order.provider_ref = p_ref then return v_order.status; end if;
    raise exception 'order_already_settled' using errcode = '22023';
  end if;
  if v_order.status <> 'pending' then raise exception 'order_not_pending' using errcode = '22023'; end if;
  v_trial_end := case when v_order.trial_days > 0 then now() + make_interval(days => v_order.trial_days) end;
  v_period_end := case v_order.plan_code
    when 'monthly' then coalesce(v_trial_end, now()) + interval '1 month'
    when 'annual' then coalesce(v_trial_end, now()) + interval '1 year'
  end;
  update public.billing_orders set status = case when v_trial_end is null then 'paid' else 'trialing' end,
    provider = p_provider, provider_ref = p_ref, settled_at = now() where id = p_order;
  insert into public.subscriptions (user_id, plan, status, trial_started_at, trial_ends_at, current_period_end, provider, provider_ref, billing_plan)
  values (v_order.user_id, 'plus', case when v_trial_end is null then 'active' else 'trialing' end,
    case when v_trial_end is null then null else now() end, v_trial_end, v_period_end, p_provider, p_ref, v_order.plan_code)
  on conflict (user_id) do update set plan = 'plus', status = excluded.status,
    trial_started_at = coalesce(public.subscriptions.trial_started_at, excluded.trial_started_at),
    trial_ends_at = excluded.trial_ends_at, current_period_end = excluded.current_period_end,
    provider = excluded.provider, provider_ref = excluded.provider_ref, billing_plan = excluded.billing_plan;
  return case when v_trial_end is null then 'paid' else 'trialing' end;
end $$;
revoke execute on function public.billing_activate(uuid, text, text) from public, anon, authenticated;
grant execute on function public.billing_activate(uuid, text, text) to service_role;
