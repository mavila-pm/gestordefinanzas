-- Apartados (named reserves, ADR-0017): money the person sets aside with a name ("Viaje", "SOAT"), an optional target
-- and an optional date. Moving money into or out of an apartado is an INTERNAL ALLOCATION of money the person already
-- has: it is never an income nor an expense, creates no transaction and changes no balance snapshot. The engine
-- subtracts what is set aside from Dinero libre (set-aside money is not free money).
--   reserves         the apartado itself; one currency for life (PEN ≠ USD), never mixed.
--   reserve_entries  append-only movements of money in ('in', "Apartar") or out ('out', "Usar"); the saved amount is
--                    Σ in − Σ out of REAL entries, never a typed total. An 'out' may point to the real movement it paid.
-- Integrity lives here, whatever the write path (form, Vels button, direct API call):
--   · an entry never takes out more than is saved (row lock on the apartado serializes concurrent entries);
--   · an archived apartado takes no entries, and an apartado with money in it cannot be archived;
--   · a linked movement is the person's own, confirmed, outgoing, not an income, in the apartado's currency, and
--     links at most one entry.

create table public.reserves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) <= 40 and char_length(btrim(name)) >= 1),
  currency public.currency_code not null,
  target_minor bigint check (target_minor between 1 and 100000000000),
  target_date date,
  active boolean not null default true,
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- A date without a target says nothing to plan for: never invented.
  constraint reserves_date_needs_target check (target_date is null or target_minor is not null)
);
create unique index reserves_active_name on public.reserves (user_id, currency, lower(btrim(name))) where active;
create unique index reserves_client_ref on public.reserves (user_id, client_ref) where client_ref is not null;

create table public.reserve_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  reserve_id uuid not null,
  direction text not null check (direction in ('in', 'out')),
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  transaction_id uuid,
  note text check (char_length(note) <= 80),
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint reserve_entries_reserve_fk foreign key (reserve_id, user_id) references public.reserves (id, user_id) on delete cascade,
  constraint reserve_entries_tx_fk foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete set null (transaction_id),
  -- Only money taken out can point to the real movement it paid; putting money in is never a movement.
  constraint reserve_entries_link_out check (direction = 'out' or transaction_id is null)
);
create index reserve_entries_reserve on public.reserve_entries (reserve_id, created_at desc);
create unique index reserve_entries_transaction on public.reserve_entries (transaction_id) where transaction_id is not null;
create unique index reserve_entries_client_ref on public.reserve_entries (user_id, client_ref) where client_ref is not null;

-- Entry guard. The apartado row is locked FOR UPDATE, so concurrent entries (and an archive) on the same apartado
-- run one after the other and each one sees the balance the previous one committed.
create function public.reserve_entries_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_reserve record;
  v_saved bigint;
  v_tx record;
begin
  select r.active, r.currency into v_reserve
  from public.reserves r where r.id = new.reserve_id and r.user_id = new.user_id for update;
  if not found then return new; end if; -- not the person's apartado: the composite FK / RLS reject it
  if not v_reserve.active then
    raise exception 'reserve_inactive' using errcode = '23514';
  end if;
  if new.direction = 'out' then
    select coalesce(sum(case when e.direction = 'in' then e.amount_minor else -e.amount_minor end), 0)::bigint into v_saved
    from public.reserve_entries e where e.reserve_id = new.reserve_id and e.user_id = new.user_id;
    if new.amount_minor > v_saved then
      raise exception 'reserve_insufficient' using errcode = '23514';
    end if;
  end if;
  if new.transaction_id is not null then
    select t.status, t.direction, t.type, t.currency into v_tx
    from public.transactions t where t.id = new.transaction_id and t.user_id = new.user_id;
    if not found then return new; end if; -- another person's movement: the composite FK rejects it
    if v_tx.status <> 'confirmed' or v_tx.direction <> 'outflow' or v_tx.type in ('income', 'deposit') or v_tx.currency <> v_reserve.currency then
      raise exception 'reserve_tx_cannot_pay' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.reserve_entries_guard() from public, anon, authenticated;
create trigger reserve_entries_guard before insert on public.reserve_entries
  for each row execute function public.reserve_entries_guard();

-- Archive guard: an apartado with money in it is not archived (the money would vanish from the plan).
create function public.reserves_archive_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_saved bigint;
begin
  if old.active and not new.active then
    select coalesce(sum(case when e.direction = 'in' then e.amount_minor else -e.amount_minor end), 0)::bigint into v_saved
    from public.reserve_entries e where e.reserve_id = old.id and e.user_id = old.user_id;
    if v_saved > 0 then
      raise exception 'reserve_not_empty' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.reserves_archive_guard() from public, anon, authenticated;
create trigger reserves_archive_guard before update of active on public.reserves
  for each row execute function public.reserves_archive_guard();

-- Saved per apartado (Σ in − Σ out), read under the caller's RLS.
create view public.reserve_balances with (security_invoker = true) as
  select r.id as reserve_id, r.user_id, r.currency,
    coalesce(sum(case when e.direction = 'in' then e.amount_minor else -e.amount_minor end), 0)::bigint as saved_minor,
    max(e.created_at) as last_entry_at
  from public.reserves r
  left join public.reserve_entries e on e.reserve_id = r.id and e.user_id = r.user_id
  group by r.id, r.user_id, r.currency;

-- ── RLS + explicit grants: own rows only; entries append-only; currency and owner never change ───────────────
alter table public.reserves enable row level security;
alter table public.reserve_entries enable row level security;
revoke all on public.reserves, public.reserve_entries, public.reserve_balances from public, anon, authenticated;
grant select, insert on public.reserves to authenticated;
grant update (name, target_minor, target_date, active, updated_at) on public.reserves to authenticated;
grant select, insert on public.reserve_entries to authenticated;
grant select on public.reserve_balances to authenticated;
create policy reserves_own on public.reserves for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy reserve_entries_own on public.reserve_entries for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
