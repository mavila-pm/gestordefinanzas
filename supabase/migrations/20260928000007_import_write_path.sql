-- TASK-006: write path for imports (pasted bank notifications) used by the ingestion pipeline running in a server
-- action with the user's session. Same model as ADR-0003: SECURITY DEFINER owned by app_writer (no BYPASSRLS).
-- Guarantees enforced HERE (not only in the app):
--   * provenance is always channel 'import' (a user can never fabricate an email/sms bank delivery);
--   * an import is never inserted as 'confirmed' (pasted text cannot prove it came from the bank);
--   * type/direction consistency, amounts, currency, dates, digits, categories from the global catalog.

-- Sources: the writer may add manual sources (000004) or import sources, nothing else.
drop policy transaction_sources_writer_insert on public.transaction_sources;
create policy transaction_sources_writer_insert on public.transaction_sources for insert to app_writer
  with check (user_id = (select public.request_uid()) and (
    (channel = 'manual' and parser_version = 'MANUAL')
    or (channel = 'import' and parser_version <> 'MANUAL')));

grant insert on public.financial_events to app_writer;
create policy financial_events_writer_insert on public.financial_events for insert to app_writer
  with check (user_id = (select public.request_uid()) and channel = 'import');

create function public.assert_import_source(p jsonb) returns void language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' or p ->> 'channel' is distinct from 'import'
     or coalesce(char_length(p ->> 'external_event_id'), 0) not between 1 and 512
     or coalesce(p ->> 'parser_version', '') !~ '^[A-Z0-9_]{1,40}$' or p ->> 'parser_version' = 'MANUAL'
     or (p ->> 'template_verification' is not null and p ->> 'template_verification' not in ('SYNTHETIC_UNVERIFIED', 'VERIFIED'))
     or public.parse_iso_ts(p ->> 'received_at') is null then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
end $$;

-- Global category id for a categorizer name; null for non-categorizable types.
create function public.import_category(p_type public.transaction_type, p_name text) returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid;
begin
  if not public.is_categorizable(p_type) then return null; end if;
  select id into v from public.categories where user_id is null and name = coalesce(p_name, 'Otros');
  if v is null then raise exception 'invalid_category' using errcode = '22023'; end if;
  return v;
end $$;

create function public.import_insert_transaction(p_tx jsonb, p_source jsonb, p_bank_operation_id text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_id uuid;
  v_type public.transaction_type;
  v_dir public.transaction_direction;
  v_amount bigint;
  v_at timestamptz;
  v_status text := p_tx ->> 'status';
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_tx is null or jsonb_typeof(p_tx) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  perform public.assert_import_source(p_source);
  if not (p_tx ->> 'type' = any (enum_range(null::public.transaction_type)::text[]))
     or not (p_tx ->> 'direction' = any (enum_range(null::public.transaction_direction)::text[])) then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  v_type := (p_tx ->> 'type')::public.transaction_type;
  v_dir := (p_tx ->> 'direction')::public.transaction_direction;
  if v_type <> 'unknown' and v_dir is distinct from public.direction_for(v_type) then raise exception 'invalid_type' using errcode = '22023'; end if;
  if jsonb_typeof(p_tx -> 'amount_minor') <> 'number' or (p_tx ->> 'amount_minor') !~ '^[0-9]{1,15}$' then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  v_amount := (p_tx ->> 'amount_minor')::bigint;
  v_at := public.parse_iso_ts(p_tx ->> 'occurred_at');
  perform public.assert_tx_fields(v_amount, v_at, p_tx ->> 'merchant_raw', p_tx ->> 'merchant_normalized');
  if coalesce(p_tx ->> 'currency', '') not in ('PEN', 'USD') then raise exception 'invalid_currency' using errcode = '22023'; end if;
  if p_tx ->> 'card_last4' is not null and p_tx ->> 'card_last4' !~ '^\d{4}$' then raise exception 'invalid_card' using errcode = '22023'; end if;
  -- Pasted text is never auto-confirmed.
  if v_status not in ('review_required', 'possible_duplicate') then raise exception 'import_must_be_reviewed' using errcode = '22023'; end if;
  if (p_tx ->> 'confidence') not in ('high', 'medium', 'low') then raise exception 'invalid_request' using errcode = '22023'; end if;
  if coalesce(char_length(p_tx ->> 'fingerprint'), 0) not between 1 and 200 then raise exception 'invalid_request' using errcode = '22023'; end if;

  insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4,
    merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint, bank_operation_id,
    original_transaction_id, duplicate_of_id)
  values (v_uid, v_at, v_type, v_dir, v_amount, (p_tx ->> 'currency')::public.currency_code, p_tx ->> 'institution_code',
    p_tx ->> 'card_last4', p_tx ->> 'merchant_raw', p_tx ->> 'merchant_normalized',
    public.import_category(v_type, p_tx ->> 'category'), v_status::public.transaction_status,
    (p_tx ->> 'confidence')::public.confidence_level, p_tx ->> 'fingerprint', left(p_bank_operation_id, 64),
    (p_tx ->> 'original_transaction_id')::uuid, (p_tx ->> 'duplicate_of_id')::uuid)
  returning id into v_id;
  insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
  values (v_uid, v_id, 'import', p_source ->> 'external_event_id', p_source ->> 'parser_version',
    (p_source ->> 'template_verification')::public.template_verification, public.parse_iso_ts(p_source ->> 'received_at'));
  return v_id;
end $$;

create function public.import_add_source(p_tx_id uuid, p_source jsonb, p_patch jsonb default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_tx public.transactions%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform public.assert_import_source(p_source);
  select * into v_tx from public.transactions where id = p_tx_id and user_id = v_uid for update;
  if v_tx.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
  values (v_uid, p_tx_id, 'import', p_source ->> 'external_event_id', p_source ->> 'parser_version',
    (p_source ->> 'template_verification')::public.template_verification, public.parse_iso_ts(p_source ->> 'received_at'));
  -- A new source may only fill a merchant the transaction did not have; it never overwrites user data.
  if p_patch ? 'merchant_raw' and v_tx.merchant_raw is null then
    perform public.assert_tx_fields(v_tx.amount_minor, v_tx.occurred_at, p_patch ->> 'merchant_raw', p_patch ->> 'merchant_normalized');
    update public.transactions set merchant_raw = p_patch ->> 'merchant_raw', merchant_normalized = p_patch ->> 'merchant_normalized',
      category_id = coalesce(category_id, public.import_category(v_tx.type, p_patch ->> 'category'))
    where id = p_tx_id and user_id = v_uid;
  end if;
end $$;

create function public.import_record_event(p_event jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.request_uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' or p_event ->> 'channel' is distinct from 'import'
     or coalesce(char_length(p_event ->> 'external_event_id'), 0) not between 1 and 512
     or not (p_event ->> 'outcome' = any (enum_range(null::public.event_outcome)::text[]))
     or (p_event ->> 'parser_version' is not null and p_event ->> 'parser_version' !~ '^[A-Z0-9_]{1,40}$') then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  insert into public.financial_events (user_id, channel, external_event_id, parser_version, outcome, detail, transaction_id)
  values (v_uid, 'import', p_event ->> 'external_event_id', p_event ->> 'parser_version',
    (p_event ->> 'outcome')::public.event_outcome, left(p_event ->> 'detail', 300), (p_event ->> 'transaction_id')::uuid);
end $$;

grant create on schema public to app_writer;
alter function public.import_insert_transaction(jsonb, jsonb, text) owner to app_writer;
alter function public.import_add_source(uuid, jsonb, jsonb) owner to app_writer;
alter function public.import_record_event(jsonb) owner to app_writer;
revoke create on schema public from app_writer;

revoke execute on function public.assert_import_source(jsonb), public.import_category(public.transaction_type, text) from public, anon, authenticated;
grant execute on function public.assert_import_source(jsonb), public.import_category(public.transaction_type, text) to app_writer;
revoke execute on function public.import_insert_transaction(jsonb, jsonb, text), public.import_add_source(uuid, jsonb, jsonb),
  public.import_record_event(jsonb) from public, anon;
grant execute on function public.import_insert_transaction(jsonb, jsonb, text), public.import_add_source(uuid, jsonb, jsonb),
  public.import_record_event(jsonb) to authenticated;
