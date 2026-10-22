-- TASK-004: close the accepted debt "authenticated users can insert/update their own transactions directly".
-- Sensitive transaction writes now go ONLY through validated, audited functions:
--   create_manual_transaction · review_transaction (confirm / ignore) · correct_transaction
-- The functions are SECURITY DEFINER but owned by `app_writer`, a NOLOGIN role WITHOUT bypassrls and not the
-- table owner, so RLS still applies inside them (second barrier) and the composite (id, user_id) FKs still hold.
-- Provenance (transaction_sources, financial_events) is never modified or deleted by these functions;
-- every change is recorded in the append-only audit_events table with before/after values.

-- ── Caller identity (same resolution as Supabase auth.uid(); usable by app_writer without auth schema access)
create function public.request_uid() returns uuid language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- ── Least-privilege writer role ────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_writer') then
    create role app_writer nologin nobypassrls;
  end if;
end $$;
-- Needed only to transfer function ownership below.
grant app_writer to postgres;
grant usage on schema public to app_writer;

-- ── Audit log (spec §36 audit_events, §61) ─────────────────────────────────
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id uuid,
  action text not null check (action in ('manual_create', 'confirm', 'ignore', 'correct')),
  -- { field: { "from": old, "to": new } } for the fields that changed.
  changes jsonb not null default '{}' check (jsonb_typeof(changes) = 'object'),
  created_at timestamptz not null default now(),
  -- Survives a future deletion of the transaction (the deletion itself must stay auditable).
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete set null (transaction_id)
);
create index audit_events_tx on public.audit_events (transaction_id, user_id) where transaction_id is not null;
create index audit_events_user_time on public.audit_events (user_id, created_at desc);
alter table public.audit_events enable row level security;

-- ── Privileges ─────────────────────────────────────────────────────────────
-- Clients: read-only on transactions (the debt), read own audit trail. Default privileges on new tables
-- (TRUNCATE/REFERENCES/TRIGGER) are revoked as in migration 000001.
revoke all on public.audit_events from anon, authenticated;
revoke insert, update, delete on public.transactions from authenticated;
grant select on public.audit_events to authenticated;
grant all on public.audit_events to service_role;

drop policy transactions_own on public.transactions;
create policy transactions_read on public.transactions for select to authenticated
  using (user_id = (select auth.uid()));
create policy audit_events_read on public.audit_events for select to authenticated
  using (user_id = (select auth.uid()));

-- app_writer: exactly what the functions need. No DELETE anywhere; no TRUNCATE.
grant select, insert, update on public.transactions to app_writer;
grant select on public.categories, public.cards, public.accounts to app_writer;
grant select, insert on public.transaction_sources, public.audit_events to app_writer;

create policy transactions_writer on public.transactions for all to app_writer
  using (user_id = (select public.request_uid()))
  with check (user_id = (select public.request_uid()) and (category_id is null or exists (
    select 1 from public.categories c where c.id = category_id and (c.user_id is null or c.user_id = (select public.request_uid())))));
create policy categories_writer_read on public.categories for select to app_writer
  using (user_id is null or user_id = (select public.request_uid()));
create policy cards_writer_read on public.cards for select to app_writer
  using (user_id = (select public.request_uid()));
create policy accounts_writer_read on public.accounts for select to app_writer
  using (user_id = (select public.request_uid()));
create policy transaction_sources_writer_read on public.transaction_sources for select to app_writer
  using (user_id = (select public.request_uid()));
-- The writer can only add MANUAL provenance: bank sources (email/sms) cannot be forged through it.
create policy transaction_sources_writer_insert on public.transaction_sources for insert to app_writer
  with check (user_id = (select public.request_uid()) and channel = 'manual' and parser_version = 'MANUAL');
create policy audit_events_writer on public.audit_events for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

-- ── Internal helpers (not callable by clients) ─────────────────────────────
create function public.direction_for(t public.transaction_type) returns public.transaction_direction
language sql immutable set search_path = '' as $$
  select case
    when t in ('expense', 'credit_card_purchase', 'credit_card_payment', 'withdrawal') then 'outflow'
    when t in ('income', 'deposit', 'refund', 'reversal') then 'inflow'
    when t = 'internal_transfer' then 'neutral'
  end::public.transaction_direction
$$;

create function public.is_categorizable(t public.transaction_type) returns boolean
language sql immutable set search_path = '' as $$
  select t in ('expense', 'credit_card_purchase', 'refund', 'reversal')
$$;

create function public.parse_iso_ts(v text) returns timestamptz language plpgsql immutable set search_path = '' as $$
begin
  if v is null or v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then return null; end if;
  return v::timestamptz;
exception when others then return null;
end $$;

-- Shared field validation. Raises with a stable code in the message; the web layer maps codes to text.
create function public.assert_tx_fields(
  p_amount_minor bigint, p_occurred_at timestamptz, p_merchant_raw text, p_merchant_normalized text
) returns void language plpgsql stable set search_path = '' as $$
begin
  if p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 100000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_occurred_at is null or p_occurred_at < '2000-01-01' or p_occurred_at > now() + interval '1 day' then
    raise exception 'invalid_date' using errcode = '22023';
  end if;
  if p_merchant_raw is not null and (char_length(p_merchant_raw) > 120 or p_merchant_raw ~ '[[:cntrl:]]') then
    raise exception 'invalid_description' using errcode = '22023';
  end if;
  if p_merchant_normalized is not null and p_merchant_normalized !~ '^[A-Z0-9& ]{1,120}$' then
    raise exception 'invalid_description' using errcode = '22023';
  end if;
end $$;

-- Resolves the category for a type: null when not categorizable; own/global category required otherwise
-- (defaults to the global 'Otros').
create function public.resolve_category(p_uid uuid, p_type public.transaction_type, p_category_id uuid)
returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid;
begin
  if not public.is_categorizable(p_type) then
    if p_category_id is not null then raise exception 'category_not_applicable' using errcode = '22023'; end if;
    return null;
  end if;
  if p_category_id is null then
    select id into v from public.categories where user_id is null and name = 'Otros';
    return v;
  end if;
  select id into v from public.categories where id = p_category_id and (user_id is null or user_id = p_uid);
  if v is null then raise exception 'invalid_category' using errcode = '22023'; end if;
  return v;
end $$;

-- ── Manual entry ───────────────────────────────────────────────────────────
create function public.create_manual_transaction(
  p_client_ref uuid,
  p_type public.transaction_type,
  p_amount_minor bigint,
  p_currency public.currency_code,
  p_occurred_at timestamptz,
  p_description text default null,
  p_description_normalized text default null,
  p_category_id uuid default null,
  p_card_id uuid default null,
  p_account_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_id uuid;
  v_card public.cards%rowtype;
  v_category uuid;
  v_desc text := nullif(btrim(p_description), '');
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_client_ref is null then raise exception 'invalid_request' using errcode = '22023'; end if;
  -- Card purchases, deposits, reversals and 'unknown' come from bank notifications, not from the manual form.
  if p_type is null or p_type not in ('expense', 'income', 'withdrawal', 'internal_transfer', 'credit_card_payment', 'refund') then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  if p_currency is null then raise exception 'invalid_currency' using errcode = '22023'; end if;
  perform public.assert_tx_fields(p_amount_minor, p_occurred_at, v_desc, p_description_normalized);
  v_category := public.resolve_category(v_uid, p_type, p_category_id);
  if p_card_id is not null then
    select * into v_card from public.cards where id = p_card_id and user_id = v_uid;
    if v_card.id is null then raise exception 'invalid_card' using errcode = '22023'; end if;
  end if;
  if p_account_id is not null and not exists (select 1 from public.accounts where id = p_account_id and user_id = v_uid) then
    raise exception 'invalid_account' using errcode = '22023';
  end if;

  -- Idempotent on the client reference (double submit / retry returns the same transaction).
  select transaction_id into v_id from public.transaction_sources
    where user_id = v_uid and channel = 'manual' and external_event_id = p_client_ref::text;
  if v_id is not null then return v_id; end if;

  begin
    insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code,
      account_id, card_id, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
    values (v_uid, p_occurred_at, p_type, public.direction_for(p_type), p_amount_minor, p_currency, v_card.institution_code,
      p_account_id, v_card.id, v_card.last4, v_desc, p_description_normalized, v_category, 'confirmed', 'high',
      'manual:' || p_client_ref::text)
    returning id into v_id;
    insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
    values (v_uid, v_id, 'manual', p_client_ref::text, 'MANUAL', null, now());
  exception when unique_violation then
    select transaction_id into v_id from public.transaction_sources
      where user_id = v_uid and channel = 'manual' and external_event_id = p_client_ref::text;
    return v_id;
  end;

  insert into public.audit_events (user_id, transaction_id, action, changes)
  values (v_uid, v_id, 'manual_create', jsonb_build_object(
    'type', jsonb_build_object('from', null, 'to', p_type),
    'amount_minor', jsonb_build_object('from', null, 'to', p_amount_minor),
    'currency', jsonb_build_object('from', null, 'to', p_currency),
    'occurred_at', jsonb_build_object('from', null, 'to', p_occurred_at)));
  return v_id;
end $$;

-- ── Review queue: confirm / ignore ─────────────────────────────────────────
create function public.review_transaction(p_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_tx public.transactions%rowtype;
  v_to public.transaction_status;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_action not in ('confirm', 'ignore') then raise exception 'invalid_action' using errcode = '22023'; end if;
  -- Same answer for "does not exist" and "belongs to someone else" (no enumeration).
  select * into v_tx from public.transactions where id = p_id and user_id = v_uid for update;
  if v_tx.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;

  v_to := case p_action when 'confirm' then 'confirmed' else 'ignored' end;
  if v_tx.status = v_to then return; end if;
  if v_to = 'confirmed' and v_tx.type = 'unknown' then raise exception 'type_required' using errcode = '22023'; end if;

  update public.transactions set status = v_to where id = p_id and user_id = v_uid;
  insert into public.audit_events (user_id, transaction_id, action, changes)
  values (v_uid, p_id, p_action, jsonb_build_object('status', jsonb_build_object('from', v_tx.status, 'to', v_to)));
end $$;

-- ── Correction (any transaction, automatic or manual) ──────────────────────
-- p_changes keys (all optional): type, amount_minor, currency, occurred_at, merchant_raw, merchant_normalized,
-- category_id, card_id, account_id. JSON null clears an optional field. Unknown keys are rejected.
-- Direction is always derived from type; fingerprint and provenance are never touched.
create function public.correct_transaction(p_id uuid, p_changes jsonb, p_confirm boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_old public.transactions%rowtype;
  v_new public.transactions%rowtype;
  v_card public.cards%rowtype;
  v_key text;
  v_diff jsonb := '{}';
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('type', 'amount_minor', 'currency', 'occurred_at', 'merchant_raw', 'merchant_normalized',
                     'category_id', 'card_id', 'account_id') then
      raise exception 'invalid_field' using errcode = '22023';
    end if;
  end loop;

  select * into v_old from public.transactions where id = p_id and user_id = v_uid for update;
  if v_old.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_new := v_old;

  if p_changes ? 'type' then
    if p_changes ->> 'type' is null or p_changes ->> 'type' = 'unknown'
       or not (p_changes ->> 'type' = any (enum_range(null::public.transaction_type)::text[])) then
      raise exception 'invalid_type' using errcode = '22023';
    end if;
    v_new.type := (p_changes ->> 'type')::public.transaction_type;
    v_new.direction := public.direction_for(v_new.type);
  end if;
  if p_changes ? 'amount_minor' then
    if jsonb_typeof(p_changes -> 'amount_minor') <> 'number' or (p_changes ->> 'amount_minor') !~ '^[0-9]{1,15}$' then
      raise exception 'invalid_amount' using errcode = '22023';
    end if;
    v_new.amount_minor := (p_changes ->> 'amount_minor')::bigint;
  end if;
  if p_changes ? 'currency' then
    if coalesce(p_changes ->> 'currency', '') not in ('PEN', 'USD') then raise exception 'invalid_currency' using errcode = '22023'; end if;
    v_new.currency := (p_changes ->> 'currency')::public.currency_code;
  end if;
  if p_changes ? 'occurred_at' then
    v_new.occurred_at := public.parse_iso_ts(p_changes ->> 'occurred_at');
  end if;
  if p_changes ? 'merchant_raw' then
    v_new.merchant_raw := nullif(btrim(p_changes ->> 'merchant_raw'), '');
  end if;
  if p_changes ? 'merchant_normalized' then
    v_new.merchant_normalized := p_changes ->> 'merchant_normalized';
  end if;
  perform public.assert_tx_fields(v_new.amount_minor, v_new.occurred_at, v_new.merchant_raw, v_new.merchant_normalized);

  if p_changes ? 'category_id' then
    if p_changes ->> 'category_id' is not null and (p_changes ->> 'category_id') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'invalid_category' using errcode = '22023';
    end if;
    if public.is_categorizable(v_new.type) and p_changes ->> 'category_id' is null then
      raise exception 'invalid_category' using errcode = '22023';
    end if;
    v_new.category_id := public.resolve_category(v_uid, v_new.type, (p_changes ->> 'category_id')::uuid);
  elsif not public.is_categorizable(v_new.type) then
    v_new.category_id := null;
  elsif v_new.category_id is null then
    v_new.category_id := public.resolve_category(v_uid, v_new.type, null);
  end if;

  if p_changes ? 'card_id' then
    if p_changes ->> 'card_id' is null then
      v_new.card_id := null;
    else
      if (p_changes ->> 'card_id') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'invalid_card' using errcode = '22023'; end if;
      select * into v_card from public.cards where id = (p_changes ->> 'card_id')::uuid and user_id = v_uid;
      if v_card.id is null then raise exception 'invalid_card' using errcode = '22023'; end if;
      -- The digits reported by the bank are evidence: a different card cannot be attached silently.
      if v_old.card_last4 is not null and v_old.card_last4 <> v_card.last4 then
        raise exception 'card_mismatch' using errcode = '22023';
      end if;
      v_new.card_id := v_card.id;
      v_new.card_last4 := coalesce(v_old.card_last4, v_card.last4);
      v_new.institution_code := coalesce(v_old.institution_code, v_card.institution_code);
    end if;
  end if;
  if p_changes ? 'account_id' then
    if p_changes ->> 'account_id' is null then
      v_new.account_id := null;
    else
      if (p_changes ->> 'account_id') !~ '^[0-9a-fA-F-]{36}$'
         or not exists (select 1 from public.accounts where id = (p_changes ->> 'account_id')::uuid and user_id = v_uid) then
        raise exception 'invalid_account' using errcode = '22023';
      end if;
      v_new.account_id := (p_changes ->> 'account_id')::uuid;
    end if;
  end if;

  if p_confirm then
    if v_new.type = 'unknown' then raise exception 'type_required' using errcode = '22023'; end if;
    v_new.status := 'confirmed';
  end if;

  -- Record exactly what changed (original values stay available in the audit trail).
  if v_new.type is distinct from v_old.type then v_diff := v_diff || jsonb_build_object('type', jsonb_build_object('from', v_old.type, 'to', v_new.type)); end if;
  if v_new.amount_minor is distinct from v_old.amount_minor then v_diff := v_diff || jsonb_build_object('amount_minor', jsonb_build_object('from', v_old.amount_minor, 'to', v_new.amount_minor)); end if;
  if v_new.currency is distinct from v_old.currency then v_diff := v_diff || jsonb_build_object('currency', jsonb_build_object('from', v_old.currency, 'to', v_new.currency)); end if;
  if v_new.occurred_at is distinct from v_old.occurred_at then v_diff := v_diff || jsonb_build_object('occurred_at', jsonb_build_object('from', v_old.occurred_at, 'to', v_new.occurred_at)); end if;
  if v_new.merchant_raw is distinct from v_old.merchant_raw then v_diff := v_diff || jsonb_build_object('merchant_raw', jsonb_build_object('from', v_old.merchant_raw, 'to', v_new.merchant_raw)); end if;
  if v_new.category_id is distinct from v_old.category_id then v_diff := v_diff || jsonb_build_object('category_id', jsonb_build_object('from', v_old.category_id, 'to', v_new.category_id)); end if;
  if v_new.card_id is distinct from v_old.card_id then v_diff := v_diff || jsonb_build_object('card_id', jsonb_build_object('from', v_old.card_id, 'to', v_new.card_id)); end if;
  if v_new.account_id is distinct from v_old.account_id then v_diff := v_diff || jsonb_build_object('account_id', jsonb_build_object('from', v_old.account_id, 'to', v_new.account_id)); end if;
  if v_new.status is distinct from v_old.status then v_diff := v_diff || jsonb_build_object('status', jsonb_build_object('from', v_old.status, 'to', v_new.status)); end if;
  if v_diff = '{}' then return; end if;

  update public.transactions set
    type = v_new.type, direction = v_new.direction, amount_minor = v_new.amount_minor, currency = v_new.currency,
    occurred_at = v_new.occurred_at, merchant_raw = v_new.merchant_raw, merchant_normalized = v_new.merchant_normalized,
    category_id = v_new.category_id, card_id = v_new.card_id, card_last4 = v_new.card_last4,
    institution_code = v_new.institution_code, account_id = v_new.account_id, status = v_new.status
  where id = p_id and user_id = v_uid;
  insert into public.audit_events (user_id, transaction_id, action, changes) values (v_uid, p_id, 'correct', v_diff);
end $$;

-- ── Ownership and EXECUTE ──────────────────────────────────────────────────
-- A non-superuser can transfer ownership only to a role with CREATE on the schema; granted just for the
-- transfer and revoked right after (app_writer never needs to create objects).
grant create on schema public to app_writer;
alter function public.create_manual_transaction(uuid, public.transaction_type, bigint, public.currency_code, timestamptz, text, text, uuid, uuid, uuid) owner to app_writer;
alter function public.review_transaction(uuid, text) owner to app_writer;
alter function public.correct_transaction(uuid, jsonb, boolean) owner to app_writer;
revoke create on schema public from app_writer;

revoke execute on function public.request_uid(), public.direction_for(public.transaction_type),
  public.is_categorizable(public.transaction_type), public.parse_iso_ts(text),
  public.assert_tx_fields(bigint, timestamptz, text, text), public.resolve_category(uuid, public.transaction_type, uuid)
  from public, anon, authenticated;
grant execute on function public.request_uid(), public.direction_for(public.transaction_type),
  public.is_categorizable(public.transaction_type), public.parse_iso_ts(text),
  public.assert_tx_fields(bigint, timestamptz, text, text), public.resolve_category(uuid, public.transaction_type, uuid)
  to app_writer;

revoke execute on function
  public.create_manual_transaction(uuid, public.transaction_type, bigint, public.currency_code, timestamptz, text, text, uuid, uuid, uuid),
  public.review_transaction(uuid, text),
  public.correct_transaction(uuid, jsonb, boolean)
  from public, anon;
grant execute on function
  public.create_manual_transaction(uuid, public.transaction_type, bigint, public.currency_code, timestamptz, text, text, uuid, uuid, uuid),
  public.review_transaction(uuid, text),
  public.correct_transaction(uuid, jsonb, boolean)
  to authenticated;
