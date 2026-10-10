-- Plan limits for automatic movements (spec §81 / §82, values in public.plan_config): on Free, at most
-- `free_auto_movements_per_month` automatic movements per Lima calendar month and automation from at most
-- `free_institutions` institution(s). Trial and Plus: no cap here (fair use later). Manual entry is never limited, an
-- already existing movement can always gain a new source (dedupe), and nothing is removed on downgrade.
-- Enforced in the only automatic write path the app uses (import_insert_transaction); the Email Bridge write path must
-- call assert_auto_allowance too when it goes live.
create or replace function public.assert_auto_allowance(p_uid uuid, p_institution text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan text := public.ai_effective_plan(p_uid);
  v_month_start timestamptz := date_trunc('month', now() at time zone 'America/Lima') at time zone 'America/Lima';
  v_limit integer := coalesce((select c.value from public.plan_config c where c.key = 'free_auto_movements_per_month'), 50);
  v_inst_limit integer := coalesce((select c.value from public.plan_config c where c.key = 'free_institutions'), 1);
  v_used integer;
  v_insts text[];
begin
  if v_plan <> 'free' then return; end if;
  select count(distinct t.id) into v_used from public.transactions t
    join public.transaction_sources s on s.transaction_id = t.id and s.user_id = t.user_id
    where t.user_id = p_uid and s.channel <> 'manual' and t.created_at >= v_month_start;
  if v_used >= v_limit then raise exception 'plan_auto_limit' using errcode = '53400'; end if;
  if p_institution is not null then
    select coalesce(array_agg(distinct t.institution_code), '{}') into v_insts from public.transactions t
      join public.transaction_sources s on s.transaction_id = t.id and s.user_id = t.user_id
      where t.user_id = p_uid and s.channel <> 'manual' and t.institution_code is not null;
    if not (p_institution = any (v_insts)) and coalesce(array_length(v_insts, 1), 0) >= v_inst_limit then
      raise exception 'plan_institution_limit' using errcode = '53400';
    end if;
  end if;
end $$;

create or replace function public.import_insert_transaction(p_tx jsonb, p_source jsonb, p_bank_operation_id text default null)
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

  -- Free plan automation limits (spec §81), enforced here so no client can skip them (migration 032).
  perform public.assert_auto_allowance(v_uid, p_tx ->> 'institution_code');

  insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4, card_id,
    merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint, bank_operation_id,
    original_transaction_id, duplicate_of_id)
  values (v_uid, v_at, v_type, v_dir, v_amount, (p_tx ->> 'currency')::public.currency_code, p_tx ->> 'institution_code',
    p_tx ->> 'card_last4', public.card_for_event(v_uid, p_tx ->> 'institution_code', p_tx ->> 'card_last4'),
    p_tx ->> 'merchant_raw', p_tx ->> 'merchant_normalized',
    public.import_category(v_type, p_tx ->> 'category'), v_status::public.transaction_status,
    (p_tx ->> 'confidence')::public.confidence_level, p_tx ->> 'fingerprint', left(p_bank_operation_id, 64),
    (p_tx ->> 'original_transaction_id')::uuid, (p_tx ->> 'duplicate_of_id')::uuid)
  returning id into v_id;
  insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
  values (v_uid, v_id, 'import', p_source ->> 'external_event_id', p_source ->> 'parser_version',
    (p_source ->> 'template_verification')::public.template_verification, public.parse_iso_ts(p_source ->> 'received_at'));
  return v_id;
end $$;

grant select on public.plan_config to app_writer;
grant create on schema public to app_writer;
alter function public.assert_auto_allowance(uuid, text) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.assert_auto_allowance(uuid, text) from public, anon, authenticated;
