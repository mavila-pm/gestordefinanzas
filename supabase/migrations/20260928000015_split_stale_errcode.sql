-- TASK-020 fix: 'stale' used SQLSTATE 40001 (serialization_failure), which PostgREST retries automatically, so a
-- stale edit hung until the gateway timeout instead of failing fast. 55000 (object_not_in_prerequisite_state) is
-- not retried. Same function otherwise; owner stays app_writer (create or replace keeps ownership).
create or replace function public.set_transaction_split(p_tx_id uuid, p_parts jsonb, p_expected_updated_at timestamptz default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_tx public.transactions%rowtype;
  v_part jsonb;
  v_total bigint := 0;
  v_amount bigint;
  v_category uuid;
  v_note text;
  v_pos smallint := 0;
  v_before jsonb;
  v_after jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then raise exception 'invalid_request' using errcode = '22023'; end if;
  select * into v_tx from public.transactions where id = p_tx_id and user_id = v_uid for update;
  if v_tx.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_expected_updated_at is not null and v_tx.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale' using errcode = '55000';
  end if;
  if jsonb_array_length(p_parts) > 0 and (v_tx.status <> 'confirmed' or v_tx.type not in ('expense', 'credit_card_purchase')) then
    raise exception 'not_splittable' using errcode = '22023';
  end if;
  if jsonb_array_length(p_parts) > 12 then raise exception 'too_many_parts' using errcode = '22023'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('category_id', category_id, 'amount_minor', amount_minor, 'note', note) order by position), '[]')
    into v_before from public.transaction_allocations where transaction_id = p_tx_id and user_id = v_uid;
  delete from public.transaction_allocations where transaction_id = p_tx_id and user_id = v_uid;

  for v_part in select * from jsonb_array_elements(p_parts) loop
    if jsonb_typeof(v_part) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_object_keys(v_part) k where k not in ('category_id', 'amount_minor', 'note', 'currency')) then
      raise exception 'invalid_request' using errcode = '22023';
    end if;
    if v_part ? 'currency' and v_part ->> 'currency' is distinct from v_tx.currency::text then
      raise exception 'currency_mismatch' using errcode = '22023';
    end if;
    if jsonb_typeof(v_part -> 'amount_minor') <> 'number' or (v_part ->> 'amount_minor') !~ '^[0-9]{1,15}$' then
      raise exception 'invalid_amount' using errcode = '22023';
    end if;
    v_amount := (v_part ->> 'amount_minor')::bigint;
    if v_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
    if coalesce(v_part ->> 'category_id', '') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'invalid_category' using errcode = '22023'; end if;
    select c.id into v_category from public.categories c
      where c.id = (v_part ->> 'category_id')::uuid and (c.user_id is null or c.user_id = v_uid);
    if v_category is null then raise exception 'invalid_category' using errcode = '22023'; end if;
    v_note := nullif(btrim(v_part ->> 'note'), '');
    if v_note is not null and char_length(v_note) > 40 then raise exception 'note_too_long' using errcode = '22023'; end if;
    v_total := v_total + v_amount;
    insert into public.transaction_allocations (user_id, transaction_id, category_id, amount_minor, note, position)
    values (v_uid, p_tx_id, v_category, v_amount, v_note, v_pos);
    v_pos := v_pos + 1;
  end loop;
  if v_total > v_tx.amount_minor then raise exception 'over_allocated' using errcode = '22023'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('category_id', category_id, 'amount_minor', amount_minor, 'note', note) order by position), '[]')
    into v_after from public.transaction_allocations where transaction_id = p_tx_id and user_id = v_uid;
  if v_after is distinct from v_before then
    -- Bumps updated_at (optimistic lock for the next editor); amount/type/status untouched.
    update public.transactions set updated_at = now() where id = p_tx_id and user_id = v_uid;
    insert into public.audit_events (user_id, transaction_id, action, changes)
    values (v_uid, p_tx_id, 'split', jsonb_build_object('allocations', jsonb_build_object('from', v_before, 'to', v_after)));
  end if;
  return v_pos;
end $$;

