-- TASK-014: link a movement to the user's registered card automatically.
-- The card is resolved in the database from (user, institution, last4); the client never supplies card_id on
-- ingestion. A link is made only when exactly ONE active card matches: two cards with the same last 4 digits stay
-- unlinked and the review queue asks the user ("sin asociar"). Linking never changes type, amount or status.

-- ── Resolution rule (single source of truth) ────────────────────────────────────────────────────────────
-- A card with no institution matches any institution; a card with one must match the event's.
create function public.card_for_event(p_uid uuid, p_institution text, p_last4 text) returns uuid
language sql stable set search_path = '' as $$
  select case when count(*) = 1 then (array_agg(c.id))[1] end
  from public.cards c
  where c.user_id = p_uid and c.active and p_last4 is not null and c.last4 = p_last4
    and (c.institution_code is null or c.institution_code is not distinct from p_institution);
$$;
revoke execute on function public.card_for_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.card_for_event(uuid, text, text) to app_writer;

alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check
  check (action in ('manual_create', 'confirm', 'ignore', 'correct', 'rule_create', 'delete', 'card_link'));

-- ── Import: same checks as 000007, plus the resolved card ───────────────────────────────────────────────
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

-- ── Registering a card links the user's past unlinked movements with those digits (audited) ─────────────
create function public.link_card_history(p_card_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_card public.cards%rowtype;
  v_n integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_card from public.cards where id = p_card_id and user_id = v_uid;
  if v_card.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  with linked as (
    update public.transactions t set card_id = v_card.id
    where t.user_id = v_uid and t.card_id is null and t.card_last4 = v_card.last4
      and public.card_for_event(v_uid, t.institution_code, t.card_last4) = v_card.id
    returning t.id
  ), audit as (
    insert into public.audit_events (user_id, transaction_id, action, changes)
    select v_uid, id, 'card_link', jsonb_build_object('card_id', jsonb_build_object('from', null, 'to', v_card.id)) from linked
    returning 1
  )
  select count(*) into v_n from audit;
  return v_n;
end $$;

grant create on schema public to app_writer;
alter function public.import_insert_transaction(jsonb, jsonb, text) owner to app_writer;
alter function public.link_card_history(uuid) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.link_card_history(uuid) from public, anon;
grant execute on function public.link_card_history(uuid) to authenticated;
