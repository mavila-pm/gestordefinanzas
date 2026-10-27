-- Money sources (UX audit 2026-10-15 §2.5–2.6, CR-001, ADR-0020): liquidity comes from what the person registers in
-- Cuentas y tarjetas — bank accounts (inside a debit card), cash and credit cards — instead of one declared total.
-- Additive only: no DROP, every new column is nullable or defaulted, old code keeps working.
--
--   accounts.kind               'bank' (default, every existing row) | 'cash' (one active "Efectivo" per currency)
--   accounts/cards.bank_name    the bank's name when it is not in the catalogue ("Otro" → "Caja Arequipa")
--   cards.color/expiry          card illustration colour (codes mapped to brand tokens) and MM/AA (expiry reminder)
--   account_balance_checkpoints append-only "saldo al <fecha>" of an account; balance = last checkpoint + confirmed
--                               movements after it (src/engine/liquidity.ts). A correction is a new checkpoint.
--   card_used_checkpoints       append-only "línea usada al <fecha>" of a credit card; used = last checkpoint + purchases
--                               − payments after it. Never liquidity.
--   card_accounts               the accounts behind a debit card ("Ahorros Soles", "Cuenta dólares"); a purchase with
--                               the card resolves to the one account in its currency (never guessed among several).
-- Never stored: full card number, CVV, PIN, OTP or passwords (last4 only, alias/bank names refuse long digit runs).

insert into public.institutions (code, name) values ('SCOTIABANK', 'Scotiabank Perú') on conflict (code) do nothing;

alter table public.accounts
  add column kind text not null default 'bank' check (kind in ('bank', 'cash')),
  add column bank_name text check (char_length(btrim(bank_name)) between 1 and 40 and regexp_replace(bank_name, '[\s-]', '', 'g') !~ '\d{5}'),
  add constraint accounts_cash_plain check (kind = 'bank' or (institution_code is null and bank_name is null and last4 is null)),
  add constraint accounts_one_bank_label check (bank_name is null or institution_code is null),
  add constraint accounts_alias_no_digits check (regexp_replace(alias, '[\s-]', '', 'g') !~ '\d{5}') not valid; -- new rows only (existing aliases untouched)
-- One active "Efectivo" per currency (PEN ≠ USD): cash is one pocket, never several invented ones.
create unique index accounts_one_cash on public.accounts (user_id, currency) where kind = 'cash' and active;

alter table public.cards
  add column color text check (color in ('black', 'gray', 'blue', 'green', 'red', 'sky', 'yellow')),
  add column bank_name text check (char_length(btrim(bank_name)) between 1 and 40 and regexp_replace(bank_name, '[\s-]', '', 'g') !~ '\d{5}'),
  add column expiry_month smallint check (expiry_month between 1 and 12),
  add column expiry_year smallint check (expiry_year between 2000 and 2099),
  add column client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  add constraint cards_expiry_pair check ((expiry_month is null) = (expiry_year is null)),
  add constraint cards_one_bank_label check (bank_name is null or institution_code is null),
  add constraint cards_alias_no_digits check (regexp_replace(alias, '[\s-]', '', 'g') !~ '\d{5}') not valid; -- new rows only (existing aliases untouched)
create unique index cards_client_ref on public.cards (user_id, client_ref) where client_ref is not null;

-- ── Account balance checkpoints ───────────────────────────────────────────────────────────────────────────
create table public.account_balance_checkpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  currency public.currency_code not null,
  -- A bank account can be overdrawn; cash cannot (guard below).
  amount_minor bigint not null check (amount_minor between -100000000000 and 100000000000),
  as_of timestamptz not null default now(),
  source text not null check (source in ('opening', 'adjustment', 'migration')),
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint account_balance_checkpoints_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade
);
-- The latest checkpoint per account (loader) and the composite FK on an account delete.
create index account_balance_checkpoints_account on public.account_balance_checkpoints (account_id, user_id, as_of desc);
create index account_balance_checkpoints_user on public.account_balance_checkpoints (user_id);
create unique index account_balance_checkpoints_client_ref on public.account_balance_checkpoints (user_id, client_ref) where client_ref is not null;

-- Same currency as its account (PEN ≠ USD), never negative cash. Runs as the table owner: the account read is
-- restricted to the row's own user_id.
create function public.account_checkpoint_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_acc record;
begin
  select a.currency, a.kind into v_acc from public.accounts a where a.id = new.account_id and a.user_id = new.user_id;
  if not found then return new; end if; -- not the person's account: the composite FK rejects it
  if v_acc.currency <> new.currency then raise exception 'checkpoint_currency' using errcode = '23514'; end if;
  if v_acc.kind = 'cash' and new.amount_minor < 0 then raise exception 'cash_negative' using errcode = '23514'; end if;
  return new;
end $$;
revoke execute on function public.account_checkpoint_guard() from public, anon, authenticated;
create trigger account_checkpoint_guard before insert on public.account_balance_checkpoints
  for each row execute function public.account_checkpoint_guard();

-- ── Credit card "used" checkpoints ────────────────────────────────────────────────────────────────────────
create table public.card_used_checkpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null,
  currency public.currency_code not null,
  used_minor bigint not null check (used_minor between 0 and 100000000000),
  as_of timestamptz not null default now(),
  source text not null check (source in ('opening', 'adjustment')),
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint card_used_checkpoints_card_fk foreign key (card_id, user_id) references public.cards (id, user_id) on delete cascade
);
create index card_used_checkpoints_card on public.card_used_checkpoints (card_id, user_id, as_of desc);
create index card_used_checkpoints_user on public.card_used_checkpoints (user_id);
create unique index card_used_checkpoints_client_ref on public.card_used_checkpoints (user_id, client_ref) where client_ref is not null;

create function public.card_used_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.cards c where c.id = new.card_id and c.user_id = new.user_id)
     and not exists (select 1 from public.cards c where c.id = new.card_id and c.user_id = new.user_id and c.kind = 'credit' and c.currency = new.currency) then
    raise exception 'used_needs_credit_card' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.card_used_guard() from public, anon, authenticated;
create trigger card_used_guard before insert on public.card_used_checkpoints
  for each row execute function public.card_used_guard();

-- ── Accounts behind a debit card ──────────────────────────────────────────────────────────────────────────
create table public.card_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id uuid not null,
  account_id uuid not null,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (card_id, account_id),
  constraint card_accounts_card_fk foreign key (card_id, user_id) references public.cards (id, user_id) on delete cascade,
  constraint card_accounts_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade
);
create index card_accounts_card on public.card_accounts (card_id, user_id);
create index card_accounts_account on public.card_accounts (account_id, user_id);
create index card_accounts_user on public.card_accounts (user_id);

create function public.card_accounts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.cards c where c.id = new.card_id and c.user_id = new.user_id and c.kind <> 'debit') then
    raise exception 'accounts_need_debit_card' using errcode = '23514';
  end if;
  if exists (select 1 from public.accounts a where a.id = new.account_id and a.user_id = new.user_id and a.kind <> 'bank') then
    raise exception 'card_account_not_bank' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.card_accounts_guard() from public, anon, authenticated;
create trigger card_accounts_guard before insert or update on public.card_accounts
  for each row execute function public.card_accounts_guard();

-- A debit-card movement without an account gets the ONE active account linked to that card in the movement's
-- currency (a USD purchase never lands in a soles account; two candidates → stays null, the person picks).
-- Covers every write path (manual, import, email, link_card_history) without rewriting them.
create function public.transactions_resolve_account() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if new.account_id is not null or new.card_id is null then return new; end if;
  select array_agg(a.id) into v_ids
  from public.card_accounts l join public.accounts a on a.id = l.account_id and a.user_id = l.user_id
  where l.card_id = new.card_id and l.user_id = new.user_id and a.active and a.currency = new.currency;
  if coalesce(array_length(v_ids, 1), 0) = 1 then new.account_id := v_ids[1]; end if;
  return new;
end $$;
revoke execute on function public.transactions_resolve_account() from public, anon, authenticated;
create trigger transactions_resolve_account before insert or update of card_id on public.transactions
  for each row execute function public.transactions_resolve_account();

-- Identity that balances depend on cannot change under them: an account with balances keeps its currency and kind,
-- a debit card with accounts stays debit, a credit card with "used" checkpoints keeps kind and currency (PEN ≠ USD).
-- Deactivate and register a new one instead.
create function public.money_source_identity_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'accounts' and (new.currency <> old.currency or new.kind <> old.kind)
     and exists (select 1 from public.account_balance_checkpoints c where c.account_id = old.id and c.user_id = old.user_id) then
    raise exception 'identity_locked' using errcode = '23514';
  end if;
  if tg_table_name = 'cards' and (new.kind <> old.kind or new.currency <> old.currency)
     and (exists (select 1 from public.card_accounts l where l.card_id = old.id and l.user_id = old.user_id)
       or exists (select 1 from public.card_used_checkpoints u where u.card_id = old.id and u.user_id = old.user_id)) then
    raise exception 'identity_locked' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.money_source_identity_guard() from public, anon, authenticated;
create trigger accounts_identity_guard before update of currency, kind on public.accounts
  for each row execute function public.money_source_identity_guard();
create trigger cards_identity_guard before update of kind, currency on public.cards
  for each row execute function public.money_source_identity_guard();

-- ── RLS + grants: own rows; checkpoints append-only (a correction is a new checkpoint) ────────────────────
alter table public.account_balance_checkpoints enable row level security;
alter table public.card_used_checkpoints enable row level security;
alter table public.card_accounts enable row level security;
revoke all on public.account_balance_checkpoints, public.card_used_checkpoints, public.card_accounts from public, anon, authenticated;
grant select, insert on public.account_balance_checkpoints, public.card_used_checkpoints to authenticated;
grant select, insert, delete on public.card_accounts to authenticated;
grant all on public.account_balance_checkpoints, public.card_used_checkpoints, public.card_accounts to service_role;
create policy account_balance_checkpoints_own on public.account_balance_checkpoints for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy card_used_checkpoints_own on public.card_used_checkpoints for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy card_accounts_own on public.card_accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ── One atomic write for "Agregar tarjeta" (with its accounts) and "Agregar cuenta a tarjeta" ─────────────
-- SECURITY INVOKER: runs as the caller under RLS (every row user_id = auth.uid()); it only makes the several
-- inserts one transaction and idempotent (same p_client_ref → same rows, nothing duplicated).
--   p_card      new card: {alias, kind, institution | bank_name, currency, last4, color, expiry_month, expiry_year,
--               credit_limit_minor, statement_day, payment_day, used_minor}  (credit: used_minor = línea usada hoy)
--   p_card_id   or an existing own active debit card to add accounts to
--   p_accounts  [{alias, currency, balance_minor}] → bank accounts of that debit card (balance = opening checkpoint)
create function public.save_money_source(p_client_ref text, p_card jsonb default null, p_card_id uuid default null,
  p_accounts jsonb default '[]'::jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_card public.cards%rowtype;
  v_acc jsonb;
  v_i integer := 0;
  v_acc_id uuid;
  v_ids uuid[] := '{}';
  v_ref text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_client_ref is null or p_client_ref !~ '^[A-Za-z0-9:_-]{8,100}$' then raise exception 'invalid_ref' using errcode = '22023'; end if;
  if (p_card is null) = (p_card_id is null) then raise exception 'invalid_request' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_accounts, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_accounts, '[]'::jsonb)) > 6 then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_card is not null then
    select * into v_card from public.cards where user_id = v_uid and client_ref = p_client_ref;
    if found then -- replay: the same submission already wrote everything
      select coalesce(array_agg(l.account_id order by a.created_at), '{}') into v_ids from public.card_accounts l
        join public.accounts a on a.id = l.account_id where l.card_id = v_card.id;
      return jsonb_build_object('card_id', v_card.id, 'account_ids', to_jsonb(v_ids), 'replay', true);
    end if;
    insert into public.cards (user_id, alias, kind, institution_code, bank_name, currency, last4, color, expiry_month, expiry_year,
      credit_limit_minor, statement_day, payment_day, client_ref)
    values (v_uid, p_card ->> 'alias', (p_card ->> 'kind')::public.card_kind, nullif(p_card ->> 'institution', ''),
      nullif(btrim(p_card ->> 'bank_name'), ''), (p_card ->> 'currency')::public.currency_code, p_card ->> 'last4', p_card ->> 'color',
      (p_card ->> 'expiry_month')::smallint, (p_card ->> 'expiry_year')::smallint,
      case when p_card ->> 'kind' = 'credit' then (p_card ->> 'credit_limit_minor')::bigint end,
      case when p_card ->> 'kind' = 'credit' then (p_card ->> 'statement_day')::smallint end,
      case when p_card ->> 'kind' = 'credit' then (p_card ->> 'payment_day')::smallint end,
      p_client_ref)
    returning * into v_card;
    if v_card.kind = 'credit' and p_card ? 'used_minor' and p_card ->> 'used_minor' is not null then
      insert into public.card_used_checkpoints (user_id, card_id, currency, used_minor, source, client_ref)
      values (v_uid, v_card.id, v_card.currency, (p_card ->> 'used_minor')::bigint, 'opening', p_client_ref || ':u');
    end if;
  else
    select * into v_card from public.cards where id = p_card_id and user_id = v_uid and active;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    if exists (select 1 from public.accounts where user_id = v_uid and client_ref = p_client_ref || ':a0') then
      select coalesce(array_agg(a.id order by a.created_at), '{}') into v_ids from public.accounts a
        where a.user_id = v_uid and a.client_ref like p_client_ref || ':a%';
      return jsonb_build_object('card_id', v_card.id, 'account_ids', to_jsonb(v_ids), 'replay', true);
    end if;
  end if;
  if jsonb_array_length(coalesce(p_accounts, '[]'::jsonb)) > 0 and v_card.kind <> 'debit' then
    raise exception 'accounts_need_debit_card' using errcode = '23514';
  end if;
  for v_acc in select value from jsonb_array_elements(coalesce(p_accounts, '[]'::jsonb)) loop
    v_ref := p_client_ref || ':a' || v_i;
    insert into public.accounts (user_id, kind, institution_code, bank_name, alias, currency, client_ref)
    values (v_uid, 'bank', v_card.institution_code, v_card.bank_name, v_acc ->> 'alias', (v_acc ->> 'currency')::public.currency_code, v_ref)
    returning id into v_acc_id;
    insert into public.card_accounts (user_id, card_id, account_id) values (v_uid, v_card.id, v_acc_id);
    if v_acc ->> 'balance_minor' is not null then
      insert into public.account_balance_checkpoints (user_id, account_id, currency, amount_minor, source, client_ref)
      values (v_uid, v_acc_id, (v_acc ->> 'currency')::public.currency_code, (v_acc ->> 'balance_minor')::bigint, 'opening', v_ref);
    end if;
    v_ids := v_ids || v_acc_id;
    v_i := v_i + 1;
  end loop;
  return jsonb_build_object('card_id', v_card.id, 'account_ids', to_jsonb(v_ids), 'replay', false);
end $$;
revoke execute on function public.save_money_source(text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.save_money_source(text, jsonb, uuid, jsonb) to authenticated;

-- "Efectivo": creates the currency's cash pocket the first time, then records "tengo S/ X en efectivo" as a new
-- checkpoint (never edits the past). Invoker, idempotent per p_client_ref. Returns the cash account id.
create function public.set_cash_balance(p_currency public.currency_code, p_amount_minor bigint, p_client_ref text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_client_ref is null or p_client_ref !~ '^[A-Za-z0-9:_-]{8,120}$' then raise exception 'invalid_ref' using errcode = '22023'; end if;
  if p_currency is null or p_amount_minor is null or p_amount_minor < 0 or p_amount_minor > 100000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  select c.account_id into v_id from public.account_balance_checkpoints c where c.user_id = v_uid and c.client_ref = p_client_ref;
  if found then return v_id; end if;
  select a.id into v_id from public.accounts a where a.user_id = v_uid and a.kind = 'cash' and a.currency = p_currency and a.active;
  if not found then
    insert into public.accounts (user_id, kind, alias, currency)
    values (v_uid, 'cash', case p_currency when 'USD' then 'Efectivo dólares' else 'Efectivo' end, p_currency)
    returning id into v_id;
  end if;
  insert into public.account_balance_checkpoints (user_id, account_id, currency, amount_minor, source, client_ref)
  values (v_uid, v_id, p_currency, p_amount_minor,
    case when exists (select 1 from public.account_balance_checkpoints c where c.account_id = v_id) then 'adjustment' else 'opening' end,
    p_client_ref);
  return v_id;
end $$;
revoke execute on function public.set_cash_balance(public.currency_code, bigint, text) from public, anon;
grant execute on function public.set_cash_balance(public.currency_code, bigint, text) to authenticated;
