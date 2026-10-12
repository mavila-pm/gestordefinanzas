-- Billing hardening (security review of 20261012000046), before any provider goes live:
-- 1) one purchase at a time per person: a per-user advisory lock serialises order creation, a new order closes the
--    previous pending ones, and activation re-checks the subscription and trial eligibility AT ACTIVATION TIME;
-- 2) activation must carry what the provider charged (amount + currency) and a non-null reference, matched against
--    the order; pending orders expire after 1 hour;
-- 3) the price the person accepted travels with the order request: if the server price differs, nothing is created.

-- The previous signatures stay in place (no DROP) but nobody can execute them any more.
revoke execute on function public.billing_create_order(text) from public, anon, authenticated;
create function public.billing_create_order(p_plan text, p_expected_minor bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_sub public.subscriptions%rowtype;
  v_days integer;
  v_trial integer := 0;
  v_price bigint;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_plan is null or p_plan not in ('monthly', 'annual', 'lifetime') then raise exception 'bad_plan' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_uid::text, 0));
  select * into v_sub from public.subscriptions where user_id = v_uid for update;
  if v_sub.billing_plan = 'lifetime' and v_sub.status = 'active' then raise exception 'already_lifetime' using errcode = '22023'; end if;
  if v_sub.billing_plan is not null and v_sub.status in ('active', 'trialing', 'past_due') then raise exception 'already_plus' using errcode = '22023'; end if;
  if (select count(*) from public.billing_orders where user_id = v_uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_orders' using errcode = '22023';
  end if;
  v_price := public.billing_price(p_plan, now());
  if p_expected_minor is null or p_expected_minor <> v_price then raise exception 'price_changed' using errcode = '22023'; end if;
  if p_plan <> 'lifetime' and v_sub.trial_started_at is null then
    select value into v_days from public.plan_config where key = 'trial_days';
    v_trial := coalesce(v_days, 14);
  end if;
  -- Only the latest purchase can be completed: earlier pending ones are closed (never two plans paid at once).
  update public.billing_orders set status = 'failed', failure = 'superseded', settled_at = now()
  where user_id = v_uid and status = 'pending';
  insert into public.billing_orders (user_id, plan_code, amount_minor, trial_days, terms_accepted_at)
  values (v_uid, p_plan, v_price, v_trial, now())
  returning id into v_id;
  return v_id;
end $$;
grant create on schema public to app_writer;
alter function public.billing_create_order(text, bigint) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.billing_create_order(text, bigint) from public, anon;
grant execute on function public.billing_create_order(text, bigint) to authenticated;

revoke execute on function public.billing_activate(uuid, text, text) from public, anon, authenticated, service_role;
create function public.billing_activate(p_order uuid, p_provider text, p_ref text, p_amount_minor bigint, p_currency text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.billing_orders%rowtype;
  v_sub public.subscriptions%rowtype;
  v_trial_end timestamptz;
  v_period_end timestamptz;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_ref is null or p_ref = '' then raise exception 'bad_reference' using errcode = '22023'; end if;
  select * into v_order from public.billing_orders where id = p_order for update;
  if not found then raise exception 'order_not_found' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_order.user_id::text, 0));
  if v_order.status in ('paid', 'trialing') then
    if v_order.provider = p_provider and v_order.provider_ref = p_ref then return v_order.status; end if;
    raise exception 'order_already_settled' using errcode = '22023';
  end if;
  if v_order.status <> 'pending' then raise exception 'order_not_pending' using errcode = '22023'; end if;
  if v_order.created_at < now() - interval '1 hour' then raise exception 'order_expired' using errcode = '22023'; end if;
  -- What the provider charged must be exactly the order (a trial order is a card authorisation: amount is the price
  -- that will be charged at the end of the trial, same check).
  if p_amount_minor is distinct from v_order.amount_minor or p_currency is distinct from v_order.currency::text then
    raise exception 'amount_mismatch' using errcode = '22023';
  end if;
  select * into v_sub from public.subscriptions where user_id = v_order.user_id for update;
  if v_sub.billing_plan is not null and v_sub.status in ('active', 'trialing', 'past_due') then raise exception 'already_plus' using errcode = '22023'; end if;
  -- Trial eligibility is decided now, not when the order was created (a card-less trial may have started since).
  if v_order.trial_days > 0 and v_sub.trial_started_at is not null then raise exception 'trial_no_longer_available' using errcode = '22023'; end if;
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
revoke execute on function public.billing_activate(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.billing_activate(uuid, text, text, bigint, text) to service_role;
