-- TASK-005: own accounts, learning from corrections (merchant rules), safe deletion of manual movements.
-- Same write model as 000004 (ADR-0003): SECURITY DEFINER functions owned by app_writer (no BYPASSRLS), audited.

-- ── Accounts: deactivate instead of delete; no duplicate (institution, last4) per user ─────────────────────
alter table public.accounts add column active boolean not null default true;
create unique index accounts_user_institution_last4 on public.accounts (user_id, coalesce(institution_code, ''), last4)
  where last4 is not null;
create unique index cards_user_institution_last4_kind on public.cards (user_id, coalesce(institution_code, ''), last4, kind)
  where active;

-- ── Merchant rules learned from corrections ──────────────────────────────────────────────────────────────
alter table public.merchant_rules
  add column source_transaction_id uuid,
  add constraint merchant_rules_source_tx foreign key (source_transaction_id, user_id)
    references public.transactions (id, user_id) on delete set null (source_transaction_id),
  -- Stored in normalized form (same normalization as the categorizer) and never shorter than 3 characters.
  add constraint merchant_rules_contains_normalized check (contains ~ '^[A-Z0-9& ]{3,80}$');
create unique index merchant_rules_user_contains on public.merchant_rules (user_id, contains);
create index merchant_rules_source_tx on public.merchant_rules (source_transaction_id, user_id) where source_transaction_id is not null;

-- ── Audit actions ────────────────────────────────────────────────────────────────────────────────────────
alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check
  check (action in ('manual_create', 'confirm', 'ignore', 'correct', 'rule_create', 'delete'));

-- ── app_writer: rules (via correction) and deletion of manual movements ────────────────────────────────
grant select, insert, update on public.merchant_rules to app_writer;
grant delete on public.transactions to app_writer;
create policy merchant_rules_writer on public.merchant_rules for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

-- ── correct_transaction: + p_remember_rule (body otherwise identical to 000004) ─────────────────────────
drop function public.correct_transaction(uuid, jsonb, boolean);
create function public.correct_transaction(p_id uuid, p_changes jsonb, p_confirm boolean default false, p_remember_rule boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_old public.transactions%rowtype;
  v_new public.transactions%rowtype;
  v_card public.cards%rowtype;
  v_key text;
  v_diff jsonb := '{}';
  v_rule_category uuid;
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
  -- Learning loop (spec §23): remember the category for this merchant. Only a global category, only for a
  -- categorizable type with a normalized merchant; exact normalized name (no broad patterns).
  if p_remember_rule then
    if not public.is_categorizable(v_new.type) or v_new.merchant_normalized is null
       or v_new.merchant_normalized !~ '^[A-Z0-9& ]{3,80}$' then
      raise exception 'rule_not_applicable' using errcode = '22023';
    end if;
    select id into v_rule_category from public.categories where id = v_new.category_id and user_id is null;
    if v_rule_category is null then raise exception 'rule_not_applicable' using errcode = '22023'; end if;
    insert into public.merchant_rules (user_id, contains, category_id, source_transaction_id)
    values (v_uid, v_new.merchant_normalized, v_rule_category, p_id)
    on conflict (user_id, contains) do update set category_id = excluded.category_id, source_transaction_id = excluded.source_transaction_id;
    insert into public.audit_events (user_id, transaction_id, action, changes)
    values (v_uid, p_id, 'rule_create', jsonb_build_object('merchant_rule', jsonb_build_object('from', null,
      'to', jsonb_build_object('contains', v_new.merchant_normalized, 'category_id', v_rule_category))));
  end if;

  if v_diff = '{}' then return; end if;

  update public.transactions set
    type = v_new.type, direction = v_new.direction, amount_minor = v_new.amount_minor, currency = v_new.currency,
    occurred_at = v_new.occurred_at, merchant_raw = v_new.merchant_raw, merchant_normalized = v_new.merchant_normalized,
    category_id = v_new.category_id, card_id = v_new.card_id, card_last4 = v_new.card_last4,
    institution_code = v_new.institution_code, account_id = v_new.account_id, status = v_new.status
  where id = p_id and user_id = v_uid;
  insert into public.audit_events (user_id, transaction_id, action, changes) values (v_uid, p_id, 'correct', v_diff);
end $$;

-- ── delete_manual_transaction: only movements whose every source is manual; automatic ones use "ignore" ──
create function public.delete_manual_transaction(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_tx public.transactions%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_tx from public.transactions where id = p_id and user_id = v_uid for update;
  if v_tx.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.transaction_sources s where s.transaction_id = p_id and s.user_id = v_uid and s.channel <> 'manual') then
    raise exception 'not_deletable' using errcode = '22023';
  end if;
  -- The audit row survives the deletion (transaction_id is set to null) and keeps what was deleted.
  insert into public.audit_events (user_id, transaction_id, action, changes)
  values (v_uid, p_id, 'delete', jsonb_build_object('deleted', jsonb_build_object('from', jsonb_build_object(
    'type', v_tx.type, 'amount_minor', v_tx.amount_minor, 'currency', v_tx.currency, 'occurred_at', v_tx.occurred_at,
    'merchant_raw', v_tx.merchant_raw, 'category_id', v_tx.category_id), 'to', null)));
  begin
    delete from public.transactions where id = p_id and user_id = v_uid;
  exception when foreign_key_violation then
    -- Another movement points to it (refund original / possible duplicate): keep it, suggest "ignore".
    raise exception 'not_deletable' using errcode = '22023';
  end;
end $$;

grant create on schema public to app_writer;
alter function public.correct_transaction(uuid, jsonb, boolean, boolean) owner to app_writer;
alter function public.delete_manual_transaction(uuid) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.correct_transaction(uuid, jsonb, boolean, boolean), public.delete_manual_transaction(uuid) from public, anon;
grant execute on function public.correct_transaction(uuid, jsonb, boolean, boolean), public.delete_manual_transaction(uuid) to authenticated;
