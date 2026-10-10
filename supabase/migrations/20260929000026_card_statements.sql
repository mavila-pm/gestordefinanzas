-- ADR-0014 Card statements: what the bank billed at a cut (total, minimum, due date) and, optionally, how much of the
-- line is used today. Entered by the person (manual) or confirmed from a camera/import read; never invented: unknown
-- amounts stay null (never 0). Post-cut purchases are not stored here: they are the card's real movements after the cut.
-- One statement per (card, cut date); a correction updates it (updated_at). Currency = the card's currency.

create table public.card_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null,
  currency public.currency_code not null,
  cut_date date not null,
  due_date date not null,
  billed_minor bigint check (billed_minor between 0 and 100000000000),
  minimum_minor bigint check (minimum_minor between 0 and 100000000000),
  used_minor bigint check (used_minor between 0 and 100000000000),
  used_as_of timestamptz,
  source text not null default 'manual' check (source in ('manual', 'camera', 'import')),
  status text not null default 'confirmed' check (status in ('confirmed', 'estimated')),
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (card_id, cut_date),
  check (due_date > cut_date and due_date <= cut_date + 62),
  check (minimum_minor is null or billed_minor is null or minimum_minor <= billed_minor),
  check ((used_minor is null) = (used_as_of is null)),
  foreign key (card_id, user_id) references public.cards (id, user_id) on delete cascade
);
create unique index card_statements_client_ref on public.card_statements (user_id, client_ref) where client_ref is not null;
create index card_statements_user_card on public.card_statements (user_id, card_id, cut_date desc);

-- The statement's currency must be its card's (a USD card never gets a PEN statement).
create function public.card_statements_currency() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.cards c where c.id = new.card_id and c.currency = new.currency and c.kind = 'credit') then
    raise exception 'statement currency must match its credit card' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger card_statements_currency before insert or update on public.card_statements
  for each row execute function public.card_statements_currency();

alter table public.card_statements enable row level security;
revoke all on public.card_statements from anon, authenticated;
-- Corrections update in place; there is no delete for the person (goes away with the card or the account).
grant select, insert, update on public.card_statements to authenticated;
create policy card_statements_own on public.card_statements for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant all on public.card_statements to service_role;
