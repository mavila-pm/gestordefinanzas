-- Billing before Culqi goes live (ADR-0018), part 3 of 3: the subscription lifecycle (spec §85).
--
-- Service-only (EXECUTE: service_role and the owner; never anon/authenticated). Each transition writes ONE ledger
-- row in billing_events keyed by '<action>:<provider reference>' BEFORE changing anything: a replayed webhook or a
-- retried request finds the row and returns 'duplicate' with no second effect. Every input comes from an object
-- the server re-fetched from the provider with the secret key (never from a browser or a webhook body), and is
-- still checked here: references by pattern, amount + currency against what was sold, dates within sane bounds.
-- Nothing here deletes data: payment state only changes what the plan allows (billing_plan_state).

-- Save (or update the card of) the person's provider customer. One per person, provider and mode.
create function public.billing_save_customer(p_user uuid, p_provider text, p_livemode boolean, p_customer_ref text, p_card_ref text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_existing text;
begin
  if p_user is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_livemode is null or p_customer_ref !~ '^[A-Za-z0-9_]{3,100}$'
     or (p_card_ref is not null and p_card_ref !~ '^[A-Za-z0-9_]{3,100}$') then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_user::text, 0));
  select customer_ref into v_existing from public.billing_customers where user_id = p_user and provider = p_provider and livemode = p_livemode for update;
  if v_existing is not null and v_existing <> p_customer_ref then raise exception 'customer_mismatch' using errcode = '22023'; end if;
  insert into public.billing_customers (user_id, provider, livemode, customer_ref, card_ref)
  values (p_user, p_provider, p_livemode, p_customer_ref, p_card_ref)
  on conflict (user_id, provider, livemode) do update set card_ref = coalesce(excluded.card_ref, public.billing_customers.card_ref);
end $$;

-- Mensual/Anual: activate with the subscription the provider created and the dates IT returned (first charge date
-- for a trial, next billing date otherwise). Idempotent per (order, subscription reference).
create function public.billing_activate_subscription(
  p_order uuid, p_provider text, p_sub_ref text, p_customer_ref text, p_card_ref text, p_amount_minor bigint, p_currency text,
  p_trial_end timestamptz, p_period_end timestamptz, p_livemode boolean
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_order public.billing_orders%rowtype;
  v_sub public.subscriptions%rowtype;
  v_start timestamptz;
  v_max interval;
  v_status text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_sub_ref is null or p_sub_ref !~ '^[A-Za-z0-9_]{3,100}$'
     or p_customer_ref is null or p_customer_ref !~ '^[A-Za-z0-9_]{3,100}$' or p_card_ref is null or p_card_ref !~ '^[A-Za-z0-9_]{3,100}$'
     or p_livemode is null then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  select o.user_id into v_user from public.billing_orders o where o.id = p_order;
  if v_user is null then raise exception 'order_not_found' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_order from public.billing_orders where id = p_order for update;
  if v_order.status in ('paid', 'trialing') then
    if v_order.provider = p_provider and v_order.provider_ref = p_sub_ref then return v_order.status; end if;
    raise exception 'order_already_settled' using errcode = '22023';
  end if;
  if v_order.status <> 'processing' then raise exception 'order_not_pending' using errcode = '22023'; end if;
  if v_order.provider is distinct from p_provider or v_order.livemode is distinct from p_livemode then raise exception 'bad_reference' using errcode = '22023'; end if;
  if v_order.plan_code not in ('monthly', 'annual') then raise exception 'not_recurring' using errcode = '22023'; end if;
  if p_amount_minor is distinct from v_order.amount_minor or p_currency is distinct from v_order.currency::text then
    raise exception 'amount_mismatch' using errcode = '22023';
  end if;
  select * into v_sub from public.subscriptions where user_id = v_user for update;
  if v_sub.billing_plan is not null and public.billing_plan_state(v_sub.plan, v_sub.status, v_sub.billing_plan, v_sub.trial_ends_at,
       v_sub.current_period_end, v_sub.cancel_at_period_end,
       coalesce((select c.value from public.plan_config c where c.key = 'billing_grace_days'), 3), now()) <> 'free' then
    raise exception 'already_plus' using errcode = '22023';
  end if;
  -- Never overwrite the reference of a subscription the provider can still charge (the new one is cancelled instead).
  if public.billing_renewal_open(v_sub.billing_plan, v_sub.status, v_sub.provider_ref, v_sub.cancel_at_period_end) then
    raise exception 'subscription_still_open' using errcode = '22023';
  end if;
  -- The trial the person accepted must be the one the provider applied: same length (±1 day), or none at all.
  if v_order.trial_days > 0 then
    if v_sub.trial_started_at is not null then raise exception 'trial_no_longer_available' using errcode = '22023'; end if;
    if p_trial_end is null or p_trial_end < now() + make_interval(days => v_order.trial_days - 1)
       or p_trial_end > now() + make_interval(days => v_order.trial_days + 1) then
      raise exception 'trial_mismatch' using errcode = '22023';
    end if;
  elsif p_trial_end is not null then
    raise exception 'trial_mismatch' using errcode = '22023';
  end if;
  -- Next charge: after the trial (± 1 day) or within one billing period from now.
  v_start := coalesce(p_trial_end, now());
  v_max := case v_order.plan_code when 'monthly' then interval '32 days' else interval '367 days' end;
  if p_period_end is null or p_period_end <= now() or p_period_end < v_start - interval '1 day' or p_period_end > v_start + v_max then
    raise exception 'bad_period' using errcode = '22023';
  end if;
  v_status := case when v_order.trial_days > 0 then 'trialing' else 'paid' end;
  update public.billing_orders set status = v_status, provider_ref = p_sub_ref, settled_at = now() where id = p_order;
  insert into public.subscriptions (user_id, plan, status, trial_started_at, trial_ends_at, current_period_end, provider, provider_ref,
    billing_plan, livemode, billing_amount_minor, billing_currency, cancel_at_period_end, canceled_at, provider_customer_ref)
  values (v_user, 'plus', case when v_order.trial_days > 0 then 'trialing' else 'active' end,
    case when v_order.trial_days > 0 then now() end, p_trial_end, p_period_end, p_provider, p_sub_ref,
    v_order.plan_code, p_livemode, v_order.amount_minor, v_order.currency, false, null, p_customer_ref)
  on conflict (user_id) do update set plan = 'plus', status = excluded.status,
    trial_started_at = coalesce(public.subscriptions.trial_started_at, excluded.trial_started_at),
    trial_ends_at = excluded.trial_ends_at, current_period_end = excluded.current_period_end,
    provider = excluded.provider, provider_ref = excluded.provider_ref, billing_plan = excluded.billing_plan,
    livemode = excluded.livemode, billing_amount_minor = excluded.billing_amount_minor, billing_currency = excluded.billing_currency,
    cancel_at_period_end = false, canceled_at = null, provider_customer_ref = excluded.provider_customer_ref;
  update public.billing_customers set card_ref = p_card_ref
  where user_id = v_user and provider = p_provider and livemode = p_livemode and customer_ref = p_customer_ref;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, order_id, livemode, amount_minor, currency, outcome, processed_at)
  values (p_provider, 'activate:' || p_order::text, 'action', 'plan.activated', p_sub_ref, v_user, p_order, p_livemode,
    v_order.amount_minor, v_order.currency, 'processed', now())
  on conflict (provider, event_ref) do nothing;
  return v_status;
end $$;

-- A period charge the provider confirmed: the plan is active until the provider's next billing date.
-- Renewal after the person cancelled: nothing is granted, the charge is flagged for a refund ('needs_refund').
create function public.billing_record_renewal(p_provider text, p_sub_ref text, p_charge_ref text, p_amount_minor bigint, p_currency text, p_period_end timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_sub public.subscriptions%rowtype;
  v_ins bigint;
  v_max interval;
begin
  if p_provider !~ '^[a-z0-9_]{2,30}$' or p_sub_ref !~ '^[A-Za-z0-9_]{3,100}$' or p_charge_ref !~ '^[A-Za-z0-9_]{3,100}$' then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  select s.user_id into v_user from public.subscriptions s where s.provider = p_provider and s.provider_ref = p_sub_ref;
  if v_user is null then raise exception 'unknown_subscription' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_sub from public.subscriptions where user_id = v_user and provider = p_provider and provider_ref = p_sub_ref for update;
  if not found then raise exception 'unknown_subscription' using errcode = '22023'; end if;
  -- A replay is answered before any state-dependent check (the first one already moved the period).
  if exists (select 1 from public.billing_events e where e.provider = p_provider and e.event_ref = 'renewal:' || p_charge_ref) then
    return 'duplicate';
  end if;
  if v_sub.billing_plan not in ('monthly', 'annual') then raise exception 'not_recurring' using errcode = '22023'; end if;
  if p_amount_minor is distinct from v_sub.billing_amount_minor or p_currency is distinct from v_sub.billing_currency::text then
    raise exception 'amount_mismatch' using errcode = '22023';
  end if;
  v_max := case v_sub.billing_plan when 'monthly' then interval '32 days' else interval '367 days' end;
  -- The new end moves forward by at most one period from the later of now and the current end.
  if p_period_end is null or p_period_end <= now() or p_period_end > greatest(now(), coalesce(v_sub.current_period_end, now())) + v_max
     or (v_sub.current_period_end is not null and p_period_end <= v_sub.current_period_end) then
    raise exception 'bad_period' using errcode = '22023';
  end if;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, livemode, amount_minor, currency, outcome, detail, processed_at)
  values (p_provider, 'renewal:' || p_charge_ref, 'action', 'plan.renewed', p_charge_ref, v_user, v_sub.livemode, p_amount_minor, v_sub.billing_currency,
    case when v_sub.cancel_at_period_end or v_sub.status = 'canceled' then 'needs_refund' else 'processed' end,
    case when v_sub.cancel_at_period_end or v_sub.status = 'canceled' then 'charged_after_cancel' end, now())
  on conflict (provider, event_ref) do nothing
  returning id into v_ins;
  if v_ins is null then return 'duplicate'; end if;
  if v_sub.cancel_at_period_end or v_sub.status = 'canceled' then return 'needs_refund'; end if;
  update public.subscriptions set status = 'active', current_period_end = p_period_end where user_id = v_user;
  return 'renewed';
end $$;

-- A period charge failed: past_due. Plus stays until the paid period ends plus the grace days (billing_plan_state).
create function public.billing_mark_past_due(p_provider text, p_sub_ref text, p_charge_ref text, p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_sub public.subscriptions%rowtype;
  v_ins bigint;
begin
  if p_provider !~ '^[a-z0-9_]{2,30}$' or p_sub_ref !~ '^[A-Za-z0-9_]{3,100}$' or p_charge_ref !~ '^[A-Za-z0-9_]{3,100}$'
     or (p_code is not null and p_code !~ '^[a-z0-9_:]{2,60}$') then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  select s.user_id into v_user from public.subscriptions s where s.provider = p_provider and s.provider_ref = p_sub_ref;
  if v_user is null then raise exception 'unknown_subscription' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_sub from public.subscriptions where user_id = v_user and provider = p_provider and provider_ref = p_sub_ref for update;
  if not found then raise exception 'unknown_subscription' using errcode = '22023'; end if;
  if v_sub.billing_plan not in ('monthly', 'annual') then raise exception 'not_recurring' using errcode = '22023'; end if;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, livemode, currency, outcome, detail, processed_at)
  values (p_provider, 'past_due:' || p_charge_ref, 'action', 'plan.past_due', p_charge_ref, v_user, v_sub.livemode, v_sub.billing_currency,
    'processed', p_code, now())
  on conflict (provider, event_ref) do nothing
  returning id into v_ins;
  if v_ins is null then return 'duplicate'; end if;
  if v_sub.status not in ('active', 'trialing') then return v_sub.status; end if;
  -- After a failed first charge the trial is over: the paid period that "ended" is the trial.
  update public.subscriptions set status = 'past_due',
    current_period_end = coalesce(current_period_end, trial_ends_at) where user_id = v_user;
  return 'past_due';
end $$;

-- "Cancelar renovación": called after the provider confirmed the subscription is cancelled (no more charges).
-- Plus stays until the end of the paid period (or of the trial); returns that date. Idempotent.
create function public.billing_cancel(p_user uuid, p_provider text, p_sub_ref text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_sub public.subscriptions%rowtype;
begin
  if p_user is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_sub_ref !~ '^[A-Za-z0-9_]{3,100}$' then raise exception 'bad_reference' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_user::text, 0));
  select * into v_sub from public.subscriptions where user_id = p_user for update;
  if not found or v_sub.provider is distinct from p_provider or v_sub.provider_ref is distinct from p_sub_ref then
    raise exception 'unknown_subscription' using errcode = '22023';
  end if;
  if v_sub.billing_plan is distinct from 'monthly' and v_sub.billing_plan is distinct from 'annual' then raise exception 'not_recurring' using errcode = '22023'; end if;
  if not v_sub.cancel_at_period_end then
    update public.subscriptions set cancel_at_period_end = true, canceled_at = now() where user_id = p_user;
    insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, livemode, outcome, processed_at)
    values (p_provider, 'cancel:' || p_sub_ref, 'action', 'plan.cancel_at_period_end', p_sub_ref, p_user, v_sub.livemode, 'processed', now())
    on conflict (provider, event_ref) do nothing;
  end if;
  return case when v_sub.status = 'trialing' then v_sub.trial_ends_at else v_sub.current_period_end end;
end $$;

-- A successful charge of a subscription that NO subscriptions row holds: its activation was refused (the order
-- closed with it), a later purchase replaced it after it was cancelled (its cancellation is in the ledger), or
-- Velsuno never knew it. Nothing is granted for it. Recorded ONCE as needs_refund under 'orphan:<charge>' (the key
-- billing_refund matches, and the guard against a second automatic refund). Returns the state ('flagged' |
-- 'duplicate') and whether the subscription is provably Velsuno's ('ours'): then the server refunds the charge and
-- stops the subscription at the provider; otherwise the owner reviews it (never an automatic refund of a charge
-- nothing links to Velsuno). A subscription a row holds is refused ('subscription_known': it is a period charge).
create function public.billing_flag_charge(p_provider text, p_charge_ref text, p_sub_ref text, p_amount_minor bigint, p_currency text,
  p_livemode boolean, p_code text)
returns table (state text, ours boolean) language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_order uuid;
  v_ours boolean := false;
  v_ins bigint;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_charge_ref is null or p_charge_ref !~ '^[A-Za-z0-9_]{3,100}$'
     or p_sub_ref is null or p_sub_ref !~ '^[A-Za-z0-9_]{3,100}$' or p_code is null or p_code !~ '^[a-z0-9_:]{2,60}$'
     or p_amount_minor is null or p_amount_minor not between 1 and 10000000 or p_currency is null or p_currency not in ('USD', 'PEN')
     or p_livemode is null then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  -- Whose it is: the order closed (or once settled) with this subscription, else its recorded cancellation.
  select o.id, o.user_id into v_order, v_user from public.billing_orders o where o.provider = p_provider and o.provider_ref = p_sub_ref;
  if v_order is not null then
    v_ours := true;
  else
    select e.user_id into v_user from public.billing_events e where e.provider = p_provider and e.event_ref = 'cancel:' || p_sub_ref;
    v_ours := found;
  end if;
  -- Same lock as every activation: a subscription being activated right now is seen as held, never refunded.
  if v_user is not null then perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0)); end if;
  if exists (select 1 from public.subscriptions s where s.provider = p_provider and s.provider_ref = p_sub_ref) then
    raise exception 'subscription_known' using errcode = '22023';
  end if;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, order_id, livemode, amount_minor, currency, outcome, detail, processed_at)
  values (p_provider, 'orphan:' || p_charge_ref, 'action', 'charge.unmatched', p_charge_ref, v_user, v_order, p_livemode, p_amount_minor,
    p_currency::public.currency_code, 'needs_refund', p_code || case when v_ours then ':ours' else ':review' end, now())
  on conflict (provider, event_ref) do nothing returning id into v_ins;
  return query select case when v_ins is null then 'duplicate' else 'flagged' end, v_ours;
end $$;

-- A refund the provider confirmed. Full refund of a Vitalicio charge: the order is refunded and the plan ends
-- (traceable; data kept). A refund of a charge that was never activated closes that order. A refund of a period
-- charge or of a flagged charge (billing_flag_charge) is recorded next to it (the plan follows its period; a flagged
-- charge granted nothing).
-- Partial refunds are recorded only.
create function public.billing_refund(p_provider text, p_charge_ref text, p_refund_ref text, p_amount_minor bigint, p_currency text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_order public.billing_orders%rowtype;
  v_user uuid;
  v_ins bigint;
  v_full boolean;
  v_kind text;
  v_charged bigint;
  v_charged_currency text;
begin
  if p_provider !~ '^[a-z0-9_]{2,30}$' or p_charge_ref !~ '^[A-Za-z0-9_]{3,100}$' or p_refund_ref !~ '^[A-Za-z0-9_]{3,100}$'
     or p_amount_minor is null or p_amount_minor < 1 or p_currency is null then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  select o.user_id into v_user from public.billing_orders o where o.provider = p_provider and o.provider_ref = p_charge_ref;
  if v_user is null then
    -- A period charge (renewal) we recorded, or a charge we flagged: the refund is recorded next to it, the plan
    -- follows its period. Never more than that charge, never in another currency.
    select e.user_id, e.event_ref, e.amount_minor, e.currency::text into v_user, v_kind, v_charged, v_charged_currency
      from public.billing_events e
      where e.provider = p_provider and e.event_ref in ('renewal:' || p_charge_ref, 'orphan:' || p_charge_ref)
      order by e.id limit 1;
    if v_kind is null then raise exception 'unknown_charge' using errcode = '22023'; end if;
    if p_currency is distinct from v_charged_currency or p_amount_minor > v_charged then raise exception 'amount_mismatch' using errcode = '22023'; end if;
    insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, amount_minor, currency, outcome, detail, processed_at)
    values (p_provider, 'refund:' || p_refund_ref, 'action', 'charge.refunded', p_charge_ref, v_user, p_amount_minor,
      p_currency::public.currency_code, 'processed', case when v_kind like 'orphan:%' then 'flagged_charge' else 'period_charge' end, now())
    on conflict (provider, event_ref) do nothing returning id into v_ins;
    return case when v_ins is null then 'duplicate' else 'recorded' end;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_user::text, 0));
  select * into v_order from public.billing_orders where provider = p_provider and provider_ref = p_charge_ref for update;
  if p_currency is distinct from v_order.currency::text or p_amount_minor > v_order.amount_minor then raise exception 'amount_mismatch' using errcode = '22023'; end if;
  v_full := p_amount_minor = v_order.amount_minor;
  insert into public.billing_events (provider, event_ref, source, type, object_ref, user_id, order_id, livemode, amount_minor, currency, outcome, detail, processed_at)
  values (p_provider, 'refund:' || p_refund_ref, 'action', 'charge.refunded', p_charge_ref, v_user, v_order.id, v_order.livemode,
    p_amount_minor, v_order.currency, 'processed', case when v_full then 'full' else 'partial' end, now())
  on conflict (provider, event_ref) do nothing returning id into v_ins;
  if v_ins is null then return 'duplicate'; end if;
  if not v_full then return 'partial'; end if;
  if v_order.status in ('paid', 'failed') and v_order.plan_code = 'lifetime' then
    update public.billing_orders set status = 'refunded' where id = v_order.id;
    update public.subscriptions set status = 'canceled', canceled_at = now()
    where user_id = v_user and provider = p_provider and provider_ref = p_charge_ref and billing_plan = 'lifetime';
  elsif v_order.status = 'failed' then
    update public.billing_orders set status = 'refunded' where id = v_order.id;
  end if;
  return 'refunded';
end $$;

revoke execute on function
  public.billing_save_customer(uuid, text, boolean, text, text),
  public.billing_activate_subscription(uuid, text, text, text, text, bigint, text, timestamptz, timestamptz, boolean),
  public.billing_record_renewal(text, text, text, bigint, text, timestamptz),
  public.billing_mark_past_due(text, text, text, text),
  public.billing_cancel(uuid, text, text),
  public.billing_flag_charge(text, text, text, bigint, text, boolean, text),
  public.billing_refund(text, text, text, bigint, text)
from public, anon, authenticated;
grant execute on function
  public.billing_save_customer(uuid, text, boolean, text, text),
  public.billing_activate_subscription(uuid, text, text, text, text, bigint, text, timestamptz, timestamptz, boolean),
  public.billing_record_renewal(text, text, text, bigint, text, timestamptz),
  public.billing_mark_past_due(text, text, text, text),
  public.billing_cancel(uuid, text, text),
  public.billing_flag_charge(text, text, text, bigint, text, boolean, text),
  public.billing_refund(text, text, text, bigint, text)
to service_role;
