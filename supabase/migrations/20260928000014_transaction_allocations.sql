-- TASK-020: "Dividir gasto". A split distributes ONE confirmed spending movement across categories.
-- It never creates money: the movement keeps amount, currency, direction, sources and dedupe identity.
-- Invariant (enforced here, not only in the UI): 0 < sum(allocations) <= transactions.amount_minor.
-- Allocations have no currency column: they are always in the movement's currency, so currencies cannot mix.

create table public.transaction_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id uuid not null,
  category_id uuid not null references public.categories (id),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 999999999999999),
  note text check (note is null or char_length(note) between 1 and 40),
  position smallint not null check (position between 0 and 11),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (transaction_id, position),
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete cascade
);
create index transaction_allocations_tx on public.transaction_allocations (transaction_id, user_id);
create index transaction_allocations_user on public.transaction_allocations (user_id);

alter table public.transaction_allocations enable row level security;
revoke all on public.transaction_allocations from anon, authenticated;
grant select on public.transaction_allocations to authenticated;
create policy transaction_allocations_read on public.transaction_allocations for select to authenticated
  using (user_id = (select auth.uid()));
-- Writes only through set_transaction_split (owned by app_writer, RLS still applies to it).
grant select, insert, delete on public.transaction_allocations to app_writer;
create policy transaction_allocations_writer on public.transaction_allocations for all to app_writer
  using (user_id = (select public.request_uid()))
  with check (user_id = (select public.request_uid()) and exists (
    select 1 from public.categories c where c.id = category_id and (c.user_id is null or c.user_id = (select public.request_uid()))));

alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check
  check (action in ('manual_create', 'confirm', 'ignore', 'correct', 'rule_create', 'delete', 'card_link', 'split'));

-- ── Guard: no path may leave a split inconsistent with its movement ────────────────────────────────────
-- Changing amount below the allocated total, the currency, the type to a non-spending one, or the status away
-- from confirmed is refused while a split exists: the user removes or adjusts the division first.
create function public.guard_transaction_split() returns trigger
language plpgsql set search_path = '' as $$
declare v_allocated bigint;
begin
  if new.amount_minor is not distinct from old.amount_minor and new.currency is not distinct from old.currency
     and new.type is not distinct from old.type and new.status is not distinct from old.status then
    return new;
  end if;
  select coalesce(sum(amount_minor), 0) into v_allocated from public.transaction_allocations
  where transaction_id = old.id and user_id = old.user_id;
  if v_allocated = 0 then return new; end if;
  if new.currency <> old.currency or new.status <> 'confirmed' or new.type not in ('expense', 'credit_card_purchase') then
    raise exception 'split_exists' using errcode = '23514';
  end if;
  if new.amount_minor < v_allocated then raise exception 'split_exceeds_amount' using errcode = '23514'; end if;
  return new;
end $$;
create trigger transactions_split_guard before update on public.transactions
  for each row execute function public.guard_transaction_split();

-- ── Write path ─────────────────────────────────────────────────────────────────────────────────────────
-- p_parts: [{ "category_id": uuid, "amount_minor": int, "note"?: text, "currency"?: must equal the movement's }]
-- An empty array removes the division. p_expected_updated_at (the version the user edited) makes concurrent edits
-- fail with 'stale' instead of silently overwriting. Atomic: replace-all inside one transaction, audited.
create function public.set_transaction_split(p_tx_id uuid, p_parts jsonb, p_expected_updated_at timestamptz default null)
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
    raise exception 'stale' using errcode = '40001';
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

grant create on schema public to app_writer;
alter function public.set_transaction_split(uuid, jsonb, timestamptz) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.set_transaction_split(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.set_transaction_split(uuid, jsonb, timestamptz) to authenticated;
revoke execute on function public.guard_transaction_split() from public, anon, authenticated;
