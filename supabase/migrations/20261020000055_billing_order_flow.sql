-- Billing before Culqi goes live (ADR-0019), part 2 of 3: one lock order and a protected charge in flight.
--
-- Defects fixed (reproduced in a throwaway Postgres, audit F-billing):
-- (a) lock-order inversion: billing_activate locked the order row and then the per-person advisory lock, while
--     billing_create_order took the advisory lock and then the order rows → 40P01 deadlock. Every billing function
--     now takes the per-person advisory lock FIRST (the person is read without a lock), then rows.
-- (b) a new order superseded an order whose charge was running, and activating that charged order then failed
--     (money taken, no Plus). The charge now starts with billing_begin_charge (pending → processing); a processing
--     order is never superseded and never expires; a new order is refused while one is in flight, at any age (a
--     lost provider answer must never lead to paying twice: support reconciles a charge whose result never came).
-- (c) the 1-hour expiry refused an order the provider had already charged (late webhook). It applies to pending
--     orders only; a processing order activates at any age.
-- (d) recurring plans are activated only with the provider's own subscription dates
--     (billing_activate_subscription, part 3); billing_activate is for the one-time Vitalicio charge.
-- (e) a lapsed Mensual/Anual whose renewal is still on at the provider (not cancelled there) could keep charging
--     while a second purchase overwrote its reference (two live subscriptions, the old one's charges unattributed).
--     While billing_renewal_open() holds, no order is created or charged and no activation overwrites the row: the
--     server cancels the old subscription at the provider first (billing_cancel), then the purchase can start.
--
-- Service-only functions (EXECUTE: service_role and the owner; never anon/authenticated): billing_begin_charge,
-- billing_fail_order, billing_activate. The server calls them through the privileged pool (lib/server-db.ts) after
-- checking the signed-in person owns the order; the provider result is re-checked here (amount, currency, mode).

-- True while a Mensual/Anual subscription can still be charged by the provider: it has a provider reference, its
-- renewal was never cancelled and it is not closed. Pure; TS mirror: renewalStillOpen (src/domain/entitlements.ts).
create function public.billing_renewal_open(p_billing_plan text, p_status text, p_provider_ref text, p_cancel boolean)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_billing_plan in ('monthly', 'annual') and p_provider_ref is not null and not coalesce(p_cancel, false)
    and p_status in ('trialing', 'active', 'past_due'), false)
$$;
revoke execute on function public.billing_renewal_open(text, text, text, boolean) from public, anon, authenticated;
-- billing_create_order runs as its owner app_writer (migration 047); the service functions run as the owner.
grant execute on function public.billing_renewal_open(text, text, text, boolean) to app_writer, service_role;

create or replace function public.billing_create_order(p_plan text, p_expected_minor bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_sub public.subscriptions%rowtype;
  v_days integer;
  v_trial integer := 0;
  v_price bigint;
  v_terms text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_plan is null or p_plan not in ('monthly', 'annual', 'lifetime') then raise exception 'bad_plan' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_uid::text, 0));
  select * into v_sub from public.subscriptions where user_id = v_uid for update;
  if v_sub.billing_plan = 'lifetime' and v_sub.status = 'active' then raise exception 'already_lifetime' using errcode = '22023'; end if;
  -- A paid plan that still gives Plus (renewing, in grace, or cancelled but not yet ended) is never bought twice.
  if v_sub.billing_plan is not null and public.billing_plan_state(v_sub.plan, v_sub.status, v_sub.billing_plan, v_sub.trial_ends_at,
       v_sub.current_period_end, v_sub.cancel_at_period_end,
       coalesce((select c.value from public.plan_config c where c.key = 'billing_grace_days'), 3), now()) <> 'free' then
    raise exception 'already_plus' using errcode = '22023';
  end if;
  -- A lapsed Mensual/Anual still renewing at the provider: cancelled there first (the server does it), never two.
  if public.billing_renewal_open(v_sub.billing_plan, v_sub.status, v_sub.provider_ref, v_sub.cancel_at_period_end) then
    raise exception 'subscription_still_open' using errcode = '22023';
  end if;
  -- A charge in flight is never superseded and never forgotten: until its result arrives (webhook, or support
  -- reconciles it) no second purchase starts, whatever its age.
  if exists (select 1 from public.billing_orders where user_id = v_uid and status = 'processing') then
    raise exception 'payment_in_progress' using errcode = '22023';
  end if;
  if (select count(*) from public.billing_orders where user_id = v_uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_orders' using errcode = '22023';
  end if;
  v_price := public.billing_price(p_plan, now());
  if p_expected_minor is null or p_expected_minor <> v_price then raise exception 'price_changed' using errcode = '22023'; end if;
  if p_plan <> 'lifetime' and v_sub.trial_started_at is null then
    select value into v_days from public.plan_config where key = 'trial_days';
    v_trial := coalesce(v_days, 14);
  end if;
  v_terms := (select d.version from public.legal_documents d where d.kind = 'terms' order by d.published_at desc limit 1);
  -- Only the latest purchase can be completed: earlier PENDING ones are closed (never a processing one).
  update public.billing_orders set status = 'failed', failure = 'superseded', settled_at = now()
  where user_id = v_uid and status = 'pending';
  insert into public.billing_orders (user_id, plan_code, amount_minor, trial_days, terms_accepted_at, terms_version)
  values (v_uid, p_plan, v_price, v_trial, now(), v_terms)
  returning id into v_id;
  return v_id;
end $$;

-- Before calling the provider: the order becomes 'processing' exactly once (a double submit gets order_not_pending
-- and never a second charge). Eligibility is re-checked here, BEFORE any money moves. Test-mode charges (sandbox
-- keys) are allowed only for demo accounts: Preview and Production share one database.
create function public.billing_begin_charge(p_order uuid, p_user uuid, p_provider text, p_livemode boolean)
returns table (plan_code text, amount_minor bigint, currency text, trial_days integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_order public.billing_orders%rowtype;
  v_sub public.subscriptions%rowtype;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_livemode is null then raise exception 'bad_reference' using errcode = '22023'; end if;
  select o.user_id into v_user from public.billing_orders o where o.id = p_order;
  if v_user is null or v_user is distinct from p_user then raise exception 'order_not_found' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_order from public.billing_orders where id = p_order for update;
  if v_order.status <> 'pending' then raise exception 'order_not_pending' using errcode = '22023'; end if;
  if v_order.created_at < now() - interval '1 hour' then raise exception 'order_expired' using errcode = '22023'; end if;
  if not p_livemode and not exists (select 1 from public.demo_access d where d.user_id = v_user) then
    raise exception 'test_mode_demo_only' using errcode = '42501';
  end if;
  select * into v_sub from public.subscriptions where user_id = v_user for update;
  if v_sub.billing_plan is not null and public.billing_plan_state(v_sub.plan, v_sub.status, v_sub.billing_plan, v_sub.trial_ends_at,
       v_sub.current_period_end, v_sub.cancel_at_period_end,
       coalesce((select c.value from public.plan_config c where c.key = 'billing_grace_days'), 3), now()) <> 'free' then
    raise exception 'already_plus' using errcode = '22023';
  end if;
  if public.billing_renewal_open(v_sub.billing_plan, v_sub.status, v_sub.provider_ref, v_sub.cancel_at_period_end) then
    raise exception 'subscription_still_open' using errcode = '22023';
  end if;
  if v_order.trial_days > 0 and v_sub.trial_started_at is not null then raise exception 'trial_no_longer_available' using errcode = '22023'; end if;
  update public.billing_orders set status = 'processing', provider = p_provider, livemode = p_livemode, processing_at = now() where id = p_order;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, order_id, livemode, amount_minor, currency, outcome, processed_at)
  values (p_provider, 'begin:' || p_order::text, 'action', 'order.processing', p_order::text, v_user, p_order, p_livemode,
    v_order.amount_minor, v_order.currency, 'processed', now());
  return query select v_order.plan_code, v_order.amount_minor, v_order.currency::text, v_order.trial_days::integer;
end $$;

-- The provider declined (a definitive answer, never a timeout): the order closes, nothing is granted. Idempotent.
-- p_charge_ref records what the provider created but could not be activated: a Vitalicio charge (refunded), or a
-- subscription (stopped at the provider). The ledger says needs_refund only when money was taken: a Vitalicio charge
-- or a subscription without trial (its plan charges at creation); a refused trial subscription charged nothing (if
-- the provider ever charges it, that charge is flagged and refunded by billing_flag_charge).
create function public.billing_fail_order(p_order uuid, p_code text, p_charge_ref text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_order public.billing_orders%rowtype;
begin
  if p_code is null or p_code !~ '^[a-z0-9_:]{2,60}$' then raise exception 'bad_reference' using errcode = '22023'; end if;
  if p_charge_ref is not null and p_charge_ref !~ '^[A-Za-z0-9_]{3,100}$' then raise exception 'bad_reference' using errcode = '22023'; end if;
  select o.user_id into v_user from public.billing_orders o where o.id = p_order;
  if v_user is null then raise exception 'order_not_found' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_order from public.billing_orders where id = p_order for update;
  if v_order.status in ('failed', 'refunded') then return v_order.status; end if;
  if v_order.status not in ('pending', 'processing') then raise exception 'order_already_settled' using errcode = '22023'; end if;
  update public.billing_orders set status = 'failed', failure = p_code, settled_at = now(),
    provider_ref = coalesce(p_charge_ref, provider_ref) where id = p_order;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, order_id, livemode, amount_minor, currency, outcome, detail, processed_at)
  values (coalesce(v_order.provider, 'none'), 'fail:' || p_order::text, 'action', 'order.failed', coalesce(p_charge_ref, p_order::text), v_user, p_order,
    v_order.livemode, v_order.amount_minor, v_order.currency,
    case when p_charge_ref is null or (v_order.plan_code <> 'lifetime' and v_order.trial_days > 0) then 'processed' else 'needs_refund' end, p_code, now())
  on conflict (provider, event_ref) do nothing;
  return 'failed';
end $$;

-- Vitalicio: called after the provider confirmed the one-time charge server to server. Idempotent per (order, ref).
create or replace function public.billing_activate(p_order uuid, p_provider text, p_ref text, p_amount_minor bigint, p_currency text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_order public.billing_orders%rowtype;
  v_sub public.subscriptions%rowtype;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_ref is null or p_ref !~ '^[A-Za-z0-9_]{3,100}$' then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  -- Lock order: the person (advisory) first, then rows — the same order as every other billing function.
  select o.user_id into v_user from public.billing_orders o where o.id = p_order;
  if v_user is null then raise exception 'order_not_found' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_order from public.billing_orders where id = p_order for update;
  if v_order.status = 'paid' then
    if v_order.provider = p_provider and v_order.provider_ref = p_ref then return v_order.status; end if;
    raise exception 'order_already_settled' using errcode = '22023';
  end if;
  if v_order.status = 'pending' then
    if v_order.created_at < now() - interval '1 hour' then raise exception 'order_expired' using errcode = '22023'; end if;
  elsif v_order.status = 'processing' then
    -- A charge in flight activates at any age, but only with the provider that started it.
    if v_order.provider is distinct from p_provider then raise exception 'bad_reference' using errcode = '22023'; end if;
  else
    raise exception 'order_not_pending' using errcode = '22023';
  end if;
  if v_order.plan_code <> 'lifetime' then raise exception 'recurring_needs_subscription' using errcode = '22023'; end if;
  if p_amount_minor is distinct from v_order.amount_minor or p_currency is distinct from v_order.currency::text then
    raise exception 'amount_mismatch' using errcode = '22023';
  end if;
  select * into v_sub from public.subscriptions where user_id = v_user for update;
  if v_sub.billing_plan is not null and public.billing_plan_state(v_sub.plan, v_sub.status, v_sub.billing_plan, v_sub.trial_ends_at,
       v_sub.current_period_end, v_sub.cancel_at_period_end,
       coalesce((select c.value from public.plan_config c where c.key = 'billing_grace_days'), 3), now()) <> 'free' then
    raise exception 'already_plus' using errcode = '22023';
  end if;
  -- Never overwrite the reference of a subscription the provider can still charge (the charge is refunded instead).
  if public.billing_renewal_open(v_sub.billing_plan, v_sub.status, v_sub.provider_ref, v_sub.cancel_at_period_end) then
    raise exception 'subscription_still_open' using errcode = '22023';
  end if;
  update public.billing_orders set status = 'paid', provider = p_provider, provider_ref = p_ref, settled_at = now() where id = p_order;
  insert into public.subscriptions (user_id, plan, status, current_period_end, provider, provider_ref, billing_plan, livemode,
    billing_amount_minor, billing_currency, cancel_at_period_end, canceled_at)
  values (v_user, 'plus', 'active', null, p_provider, p_ref, 'lifetime', v_order.livemode, v_order.amount_minor, v_order.currency, false, null)
  on conflict (user_id) do update set plan = 'plus', status = 'active', trial_ends_at = null, current_period_end = null,
    provider = excluded.provider, provider_ref = excluded.provider_ref, billing_plan = 'lifetime', livemode = excluded.livemode,
    billing_amount_minor = excluded.billing_amount_minor, billing_currency = excluded.billing_currency,
    cancel_at_period_end = false, canceled_at = null, provider_customer_ref = null;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, order_id, livemode, amount_minor, currency, outcome, processed_at)
  values (p_provider, 'activate:' || p_order::text, 'action', 'plan.activated', p_ref, v_user, p_order, v_order.livemode,
    v_order.amount_minor, v_order.currency, 'processed', now())
  on conflict (provider, event_ref) do nothing;
  return 'paid';
end $$;

revoke execute on function public.billing_begin_charge(uuid, uuid, text, boolean), public.billing_fail_order(uuid, text, text),
  public.billing_activate(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.billing_begin_charge(uuid, uuid, text, boolean), public.billing_fail_order(uuid, text, text),
  public.billing_activate(uuid, text, text, bigint, text) to service_role;
