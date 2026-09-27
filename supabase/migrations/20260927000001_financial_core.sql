-- Financial core schema (Beta Core). Money = bigint minor units, always positive;
-- type/direction carry meaning. Every user-owned row carries user_id and is protected by RLS.
-- Cross-user references are impossible by construction: FKs are composite (id, user_id).

create extension if not exists pgcrypto;

-- ── Enums ──────────────────────────────────────────────────────────────────
create type public.currency_code as enum ('PEN', 'USD');
create type public.transaction_type as enum (
  'expense', 'income', 'credit_card_purchase', 'credit_card_payment', 'internal_transfer',
  'deposit', 'withdrawal', 'refund', 'reversal', 'unknown');
create type public.transaction_direction as enum ('inflow', 'outflow', 'neutral');
create type public.transaction_status as enum ('confirmed', 'review_required', 'possible_duplicate', 'ignored');
create type public.confidence_level as enum ('high', 'medium', 'low');
create type public.source_channel as enum ('email', 'sms', 'manual');
create type public.card_kind as enum ('credit', 'debit');
create type public.template_verification as enum ('SYNTHETIC_UNVERIFIED', 'VERIFIED');
create type public.event_outcome as enum (
  'created', 'duplicate_same_event', 'merged_cross_source', 'possible_duplicate',
  'unresolved', 'non_transactional', 'not_financial', 'rejected');

-- ── Profiles ───────────────────────────────────────────────────────────────
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Global catalogs (read-only for users) ─────────────────────────────────
create table public.institutions (
  code text primary key check (code ~ '^[A-Z_]{2,20}$'),
  name text not null
);
insert into public.institutions (code, name) values
  ('BCP', 'Banco de Crédito del Perú'), ('BBVA', 'BBVA Perú'), ('INTERBANK', 'Interbank');

-- user_id null = default category shared by everyone (read-only); otherwise user-owned.
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  unique nulls not distinct (user_id, name)
);
insert into public.categories (name) values
  ('Alimentación'), ('Transporte'), ('Vivienda'), ('Servicios'), ('Salud'),
  ('Ocio'), ('Educación'), ('Personal'), ('Otros');

-- ── Accounts and cards (never full numbers, PIN, CVV or credentials) ──────
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  institution_code text references public.institutions (code),
  alias text not null check (char_length(alias) between 1 and 60),
  currency public.currency_code not null,
  last4 text check (last4 ~ '^\d{4}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  institution_code text references public.institutions (code),
  alias text not null check (char_length(alias) between 1 and 60),
  kind public.card_kind not null,
  currency public.currency_code not null,
  last4 text not null check (last4 ~ '^\d{4}$'),
  credit_limit_minor bigint check (credit_limit_minor >= 0),
  statement_day smallint check (statement_day between 1 and 31),
  payment_day smallint check (payment_day between 1 and 31),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.merchant_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  contains text not null check (char_length(contains) between 2 and 80),
  category_id uuid not null references public.categories (id),
  created_at timestamptz not null default now()
);

-- ── Transactions ───────────────────────────────────────────────────────────
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurred_at timestamptz not null,
  type public.transaction_type not null,
  direction public.transaction_direction not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency public.currency_code not null,
  institution_code text references public.institutions (code),
  account_id uuid,
  card_id uuid,
  card_last4 text check (card_last4 ~ '^\d{4}$'),
  merchant_raw text check (char_length(merchant_raw) <= 120),
  merchant_normalized text check (char_length(merchant_normalized) <= 120),
  category_id uuid references public.categories (id),
  status public.transaction_status not null,
  confidence public.confidence_level not null,
  fingerprint text not null,
  bank_operation_id text check (char_length(bank_operation_id) <= 64),
  original_transaction_id uuid,
  duplicate_of_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (account_id, user_id) references public.accounts (id, user_id),
  foreign key (card_id, user_id) references public.cards (id, user_id),
  foreign key (original_transaction_id, user_id) references public.transactions (id, user_id),
  foreign key (duplicate_of_id, user_id) references public.transactions (id, user_id),
  -- Direction is determined by type (financial correctness invariant).
  check (
    (type in ('expense', 'credit_card_purchase', 'credit_card_payment', 'withdrawal') and direction = 'outflow')
    or (type in ('income', 'deposit', 'refund', 'reversal') and direction = 'inflow')
    or (type = 'internal_transfer' and direction = 'neutral')
    or (type = 'unknown')
  )
);
create index transactions_user_time on public.transactions (user_id, occurred_at desc);
create index transactions_dedupe on public.transactions (user_id, institution_code, amount_minor, currency, occurred_at);
create index transactions_bank_op on public.transactions (user_id, institution_code, bank_operation_id) where bank_operation_id is not null;

-- One row per source that reported a transaction (email + SMS = 2 rows, 1 transaction).
create table public.transaction_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transaction_id uuid not null,
  channel public.source_channel not null,
  external_event_id text not null check (char_length(external_event_id) <= 512),
  parser_version text not null check (char_length(parser_version) <= 40),
  template_verification public.template_verification,
  received_at timestamptz not null,
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete cascade,
  -- Level-1 idempotency enforced by the database, safe under concurrency.
  unique (user_id, channel, external_event_id)
);

-- Trace of every received event, including those that produced no transaction.
-- Stores no message body (data minimization, §33).
create table public.financial_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  channel public.source_channel not null,
  external_event_id text not null check (char_length(external_event_id) <= 512),
  parser_version text check (char_length(parser_version) <= 40),
  outcome public.event_outcome not null,
  detail text check (char_length(detail) <= 300),
  transaction_id uuid,
  created_at timestamptz not null default now(),
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete set null (transaction_id)
);
create index financial_events_user_time on public.financial_events (user_id, created_at desc);

-- ── updated_at ─────────────────────────────────────────────────────────────
create function public.touch_updated_at() returns trigger language plpgsql
set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger transactions_touch before update on public.transactions for each row execute function public.touch_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.institutions enable row level security;
alter table public.categories enable row level security;
alter table public.accounts enable row level security;
alter table public.cards enable row level security;
alter table public.merchant_rules enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_sources enable row level security;
alter table public.financial_events enable row level security;

-- anon gets nothing.
revoke all on all tables in schema public from anon;

grant select on public.institutions to authenticated;
create policy institutions_read on public.institutions for select to authenticated using (true);

grant select, insert, update, delete on public.categories to authenticated;
create policy categories_read on public.categories for select to authenticated
  using (user_id is null or user_id = (select auth.uid()));
create policy categories_write on public.categories for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update on public.profiles to authenticated;
create policy profiles_own on public.profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Fully user-owned tables: CRUD on own rows only.
grant select, insert, update, delete on public.accounts, public.cards, public.merchant_rules, public.transactions to authenticated;
create policy accounts_own on public.accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy cards_own on public.cards for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy merchant_rules_own on public.merchant_rules for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.categories c where c.id = category_id and (c.user_id is null or c.user_id = (select auth.uid()))));
create policy transactions_own on public.transactions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (category_id is null or exists (
    select 1 from public.categories c where c.id = category_id and (c.user_id is null or c.user_id = (select auth.uid())))));

-- Provenance is written only by the server-side ingestion (service role). Users can read their own.
grant select on public.transaction_sources, public.financial_events to authenticated;
create policy transaction_sources_read on public.transaction_sources for select to authenticated
  using (user_id = (select auth.uid()));
create policy financial_events_read on public.financial_events for select to authenticated
  using (user_id = (select auth.uid()));

grant all on all tables in schema public to service_role;
