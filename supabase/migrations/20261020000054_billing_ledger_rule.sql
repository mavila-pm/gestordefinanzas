-- Billing before Culqi goes live (ADR-0018), part 1 of 3: states, provider references, test/live split, the
-- append-only billing ledger, saved provider customers and ONE entitlement rule (shared by SQL and TypeScript).
--
-- * billing_orders: new states 'processing' (a provider charge is in flight: it can never be superseded or expire)
--   and 'refunded'; livemode (set when the charge starts, never by the browser), terms_version, processing_at.
-- * subscriptions: cancel_at_period_end + canceled_at (Plus kept until the paid period ends), livemode, the amount
--   and currency the provider charges every period (renewals must match it), the provider customer reference.
--   One subscription per provider reference.
-- * billing_events: append-only ledger (spec §86: plan changes, cancellations, refunds) and webhook idempotency key
--   (provider, event_ref). Server only: no client grants. A row may only be closed once (outcome + processed_at).
-- * billing_customers: the provider customer + card reference per person and mode (no card data: the provider keeps
--   it). Server only.
-- * billing_plan_state(): the single entitlement rule; ai_effective_plan() now uses it. Mirrored by
--   src/domain/entitlements.ts (planState) and checked row by row by tests/db/entitlements-parity.test.ts.
--   Grace: plan_config.billing_grace_days after the end of a paid period that is being renewed (past_due or a
--   renewal not yet confirmed). Cancel at period end: Plus until the end of the paid period, then Free. Data is
--   never deleted by payment state.

-- ── Orders ───────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
  -- The two status checks of 000046 (inline status list, pending ⇔ not settled) are replaced by named ones.
  for r in select conname from pg_constraint
    where conrelid = 'public.billing_orders'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table public.billing_orders drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.billing_orders
  add constraint billing_orders_status_check
    check (status in ('pending', 'processing', 'paid', 'trialing', 'failed', 'simulated', 'refunded')),
  add constraint billing_orders_settled_check check ((status in ('pending', 'processing')) = (settled_at is null)),
  add column livemode boolean,
  add column terms_version text check (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  add column processing_at timestamptz,
  add constraint billing_orders_processing_check check (status <> 'processing' or (processing_at is not null and provider is not null and livemode is not null));

-- ── Subscriptions ────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.subscriptions
  add column cancel_at_period_end boolean not null default false,
  add column canceled_at timestamptz,
  add column livemode boolean,
  add column billing_amount_minor bigint check (billing_amount_minor between 1 and 10000000),
  add column billing_currency public.currency_code,
  add column provider_customer_ref text check (provider_customer_ref ~ '^[A-Za-z0-9_]{3,100}$'),
  add constraint subscriptions_cancel_check check (not cancel_at_period_end or billing_plan in ('monthly', 'annual'));
create unique index subscriptions_provider_ref on public.subscriptions (provider, provider_ref) where provider_ref is not null;

-- ── Ledger ───────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.billing_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  -- Idempotency key: the webhook event id (or a digest of the delivery), or '<action>:<reference>' for effects.
  event_ref text not null check (char_length(event_ref) between 3 and 200),
  source text not null check (source in ('webhook', 'action')),
  type text not null check (type ~ '^[a-z0-9_.]{2,60}$'),
  object_ref text check (object_ref ~ '^[A-Za-z0-9_:-]{1,200}$'),
  user_id uuid references auth.users (id) on delete set null,
  order_id uuid,
  livemode boolean,
  amount_minor bigint check (amount_minor between 0 and 10000000),
  currency public.currency_code,
  outcome text not null check (outcome in ('received', 'processed', 'duplicate', 'ignored', 'rejected', 'error', 'needs_refund')),
  detail text check (detail ~ '^[a-z0-9_:.-]{1,200}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_ref),
  foreign key (order_id, user_id) references public.billing_orders (id, user_id) on delete set null (order_id)
);
create index billing_events_user on public.billing_events (user_id, received_at desc) where user_id is not null;
create index billing_events_object on public.billing_events (provider, object_ref) where object_ref is not null;

-- Append-only: rows are never deleted; a row can be closed once (outcome/detail/processed_at while processed_at is
-- null); account deletion may null the links (FK set null); nothing else ever changes.
create function public.billing_events_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'billing_events_append_only' using errcode = '42501'; end if;
  if (new.id, new.provider, new.event_ref, new.source, new.type, new.object_ref, new.livemode, new.amount_minor, new.currency, new.received_at)
     is distinct from (old.id, old.provider, old.event_ref, old.source, old.type, old.object_ref, old.livemode, old.amount_minor, old.currency, old.received_at)
     or (new.user_id is distinct from old.user_id and new.user_id is not null)
     or (new.order_id is distinct from old.order_id and new.order_id is not null) then
    raise exception 'billing_events_append_only' using errcode = '42501';
  end if;
  if (new.outcome, new.detail, new.processed_at) is distinct from (old.outcome, old.detail, old.processed_at)
     and (old.processed_at is not null or new.processed_at is null) then
    raise exception 'billing_events_append_only' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.billing_events_guard() from public, anon, authenticated;
create trigger billing_events_append_only before update or delete on public.billing_events
  for each row execute function public.billing_events_guard();

alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;
grant select, insert, update on public.billing_events to service_role;

-- ── Provider customers (server only) ─────────────────────────────────────────────────────────────────────────────
create table public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  livemode boolean not null,
  customer_ref text not null check (customer_ref ~ '^[A-Za-z0-9_]{3,100}$'),
  card_ref text check (card_ref ~ '^[A-Za-z0-9_]{3,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, provider, livemode),
  unique (provider, customer_ref)
);
create trigger billing_customers_touch before update on public.billing_customers for each row execute function public.touch_updated_at();
alter table public.billing_customers enable row level security;
revoke all on public.billing_customers from anon, authenticated;
grant select, insert, update on public.billing_customers to service_role;

-- ── Terms version recorded on each order (billing_create_order runs as app_writer) ──────────────────────────────
grant select on public.legal_documents to app_writer;
create policy legal_documents_writer_read on public.legal_documents for select to app_writer using (true);

-- ── One entitlement rule ─────────────────────────────────────────────────────────────────────────────────────────
insert into public.plan_config (key, value, note) values
  ('billing_grace_days', 3, 'PROPUESTO ADR-0018: días con Plus tras el fin de un periodo pagado cuya renovación aún no se confirma (pago pendiente)')
on conflict (key) do nothing;

-- 'free' | 'trial' | 'plus'. Pure: same inputs → same answer (TS mirror: planState in src/domain/entitlements.ts).
create function public.billing_plan_state(
  p_plan text, p_status text, p_billing_plan text, p_trial_ends_at timestamptz, p_period_end timestamptz,
  p_cancel boolean, p_grace_days integer, p_now timestamptz
) returns text language sql immutable set search_path = '' as $$
  select case
    when p_status is null then 'free'
    -- Any trial (card-less or card-backed) is Plus until its exact end.
    when p_status = 'trialing' then case
      when p_trial_ends_at > p_now then 'trial'
      -- Card-backed trial whose first charge is being confirmed: grace days, never after a cancellation.
      when p_billing_plan in ('monthly', 'annual') and not coalesce(p_cancel, false)
        and p_trial_ends_at + make_interval(days => greatest(coalesce(p_grace_days, 0), 0)) > p_now then 'plus'
      else 'free' end
    when p_plan is distinct from 'plus' then 'free'
    when p_status = 'active' and p_billing_plan = 'lifetime' then 'plus'
    -- Recurring paid plan (renewing, past due or cancelled at period end): until the paid period ends, plus the
    -- grace days while a renewal is expected; a period without an end never grants Plus (fail closed).
    when p_status in ('active', 'past_due') and p_billing_plan in ('monthly', 'annual') then case
      when p_period_end is null then 'free'
      when p_period_end + case when coalesce(p_cancel, false) then interval '0' else make_interval(days => greatest(coalesce(p_grace_days, 0), 0)) end > p_now then 'plus'
      else 'free' end
    -- Plus granted by hand (no billing plan): until its end, if it has one.
    when p_status = 'active' and p_billing_plan is null then case when p_period_end is null or p_period_end > p_now then 'plus' else 'free' end
    when p_status = 'past_due' and p_billing_plan is null then case when p_period_end > p_now then 'plus' else 'free' end
    else 'free'
  end
$$;
revoke execute on function public.billing_plan_state(text, text, text, timestamptz, timestamptz, boolean, integer, timestamptz) from public, anon;
grant execute on function public.billing_plan_state(text, text, text, timestamptz, timestamptz, boolean, integer, timestamptz)
  to authenticated, app_writer, service_role;

-- The person's effective plan for limits (AI quota, automatic movements): demo simulation first, then the rule.
create or replace function public.ai_effective_plan(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select d.simulated_plan from public.demo_access d where d.user_id = p_uid),
    (select public.billing_plan_state(s.plan, s.status, s.billing_plan, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end,
        coalesce((select c.value from public.plan_config c where c.key = 'billing_grace_days'), 3), now())
     from public.subscriptions s where s.user_id = p_uid),
    'free')
$$;
