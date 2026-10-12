-- ADR-0013 "Aplicar plan": the person saves the plan they saw (reservations until the next income).
-- It never pays, transfers, creates movements or marks anything as paid: realized = a real settlement, computed at
-- read time from plan_settlements. One active plan per (user, currency); a new one supersedes it; history is kept
-- (append-only: no delete, amounts immutable). Server computes every amount; the client only picks base + currency.

create table public.plan_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  currency public.currency_code not null,
  status text not null default 'active' check (status in ('active', 'superseded', 'cancelled')),
  base_kind text not null check (base_kind in ('balance', 'income')),
  base_minor bigint not null check (base_minor between -100000000000 and 100000000000),
  base_transaction_id uuid,
  from_date date not null,
  until_date date not null,
  reserved_minor bigint not null check (reserved_minor between 0 and 100000000000),
  free_minor bigint not null check (free_minor between -100000000000 and 100000000000),
  plan_status text not null check (plan_status in ('confirmed', 'partial')),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 60 and pg_column_size(lines) <= 16000),
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, user_id),
  check (until_date >= from_date),
  check ((status = 'active') = (closed_at is null)),
  check ((base_kind = 'income') = (base_transaction_id is not null)),
  check (free_minor = base_minor - reserved_minor),
  foreign key (base_transaction_id, user_id) references public.transactions (id, user_id) on delete set null (base_transaction_id),
  foreign key (supersedes_id, user_id) references public.plan_applications (id, user_id)
);
-- The rule is in the database, not the button: at most one active plan per currency.
create unique index plan_applications_one_active on public.plan_applications (user_id, currency) where status = 'active';
create unique index plan_applications_client_ref on public.plan_applications (user_id, client_ref) where client_ref is not null;
create index plan_applications_user on public.plan_applications (user_id, created_at desc);

-- Only the status can change, and only out of 'active' (no reopening, no rewriting a closed plan).
create function public.plan_applications_transition() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'active' then raise exception 'plan application closed' using errcode = '22023'; end if;
  if new.status = 'active' then raise exception 'plan application already active' using errcode = '22023'; end if;
  return new;
end $$;
create trigger plan_applications_transition before update on public.plan_applications
  for each row execute function public.plan_applications_transition();

alter table public.plan_applications enable row level security;
revoke all on public.plan_applications from anon, authenticated;
grant select, insert on public.plan_applications to authenticated;
grant update (status, closed_at) on public.plan_applications to authenticated;
create policy plan_applications_own on public.plan_applications for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant all on public.plan_applications to service_role;

-- Apply = supersede the active plan of that currency and insert the new one, atomically. Security invoker (RLS
-- applies); the per-user/currency advisory lock serializes two tabs; a repeated client_ref returns the same row.
create function public.apply_plan(
  p_currency public.currency_code, p_base_kind text, p_base_minor bigint, p_base_transaction_id uuid,
  p_from date, p_until date, p_reserved_minor bigint, p_free_minor bigint, p_plan_status text, p_lines jsonb, p_client_ref text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare uid uuid := auth.uid(); prev uuid; out_id uuid;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':plan:' || p_currency::text, 0));
  if p_client_ref is not null then
    select id into out_id from public.plan_applications where user_id = uid and client_ref = p_client_ref;
    if out_id is not null then return out_id; end if;
  end if;
  update public.plan_applications set status = 'superseded', closed_at = now()
    where user_id = uid and currency = p_currency and status = 'active' returning id into prev;
  insert into public.plan_applications (user_id, currency, base_kind, base_minor, base_transaction_id, from_date, until_date,
    reserved_minor, free_minor, plan_status, lines, client_ref, supersedes_id)
  values (uid, p_currency, p_base_kind, p_base_minor, p_base_transaction_id, p_from, p_until,
    p_reserved_minor, p_free_minor, p_plan_status, p_lines, p_client_ref, prev)
  returning id into out_id;
  return out_id;
end $$;
revoke all on function public.apply_plan(public.currency_code, text, bigint, uuid, date, date, bigint, bigint, text, jsonb, text) from public, anon;
grant execute on function public.apply_plan(public.currency_code, text, bigint, uuid, date, date, bigint, bigint, text, jsonb, text) to authenticated;
