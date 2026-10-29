-- Where an own transfer or an ATM withdrawal went (ADR-0020, UX audit §2.6): −source +destination, so liquidity moves
-- money between the person's own pockets instead of losing it. Additive only: no DROP.
--   transactions.counterparty_account_id  the destination account (own, same currency; a withdrawal → cash)
--   transactions_cash_destination          an ATM withdrawal goes to the ONE active cash pocket of its currency
--                                          (there is at most one by 057's unique index: deterministic, never a guess)
--   set_transaction_counterparty()         "¿A qué cuenta fue?" — the person picks or clears the destination

alter table public.transactions
  add column counterparty_account_id uuid,
  add constraint transactions_counterparty_fk foreign key (counterparty_account_id, user_id)
    references public.accounts (id, user_id) on delete set null (counterparty_account_id),
  add constraint transactions_counterparty_type check (counterparty_account_id is null or type in ('internal_transfer', 'withdrawal')),
  add constraint transactions_counterparty_distinct check (counterparty_account_id is null or account_id is null or counterparty_account_id <> account_id);
create index transactions_counterparty on public.transactions (counterparty_account_id, user_id);

-- Insert: a withdrawal without destination goes to the cash pocket of its currency, when there is one.
-- Update: a movement corrected to another type loses its destination (the check above would refuse it otherwise).
create function public.transactions_cash_destination() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.type not in ('internal_transfer', 'withdrawal') then
    new.counterparty_account_id := null;
    return new;
  end if;
  if tg_op = 'INSERT' and new.type = 'withdrawal' and new.counterparty_account_id is null then
    select a.id into new.counterparty_account_id from public.accounts a
    where a.user_id = new.user_id and a.kind = 'cash' and a.active and a.currency = new.currency
      and a.id is distinct from new.account_id;
  end if;
  return new;
end $$;
revoke execute on function public.transactions_cash_destination() from public, anon, authenticated;
create trigger transactions_cash_destination before insert or update of type on public.transactions
  for each row execute function public.transactions_cash_destination();

-- "¿A qué cuenta fue?": own active account, same currency, not the source; a withdrawal only to cash. null clears it.
create function public.set_transaction_counterparty(p_id uuid, p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_tx record;
  v_acc record;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select t.type, t.currency, t.account_id into v_tx from public.transactions t where t.id = p_id and t.user_id = v_uid for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_tx.type not in ('internal_transfer', 'withdrawal') then raise exception 'counterparty_not_applicable' using errcode = '22023'; end if;
  if p_account is not null then
    select a.currency, a.kind, a.active into v_acc from public.accounts a where a.id = p_account and a.user_id = v_uid;
    if not found or not v_acc.active then raise exception 'invalid_account' using errcode = '22023'; end if;
    if v_acc.currency <> v_tx.currency then raise exception 'invalid_account_currency' using errcode = '22023'; end if;
    if p_account = v_tx.account_id then raise exception 'same_account' using errcode = '22023'; end if;
    if v_tx.type = 'withdrawal' and v_acc.kind <> 'cash' then raise exception 'withdrawal_needs_cash' using errcode = '22023'; end if;
  end if;
  update public.transactions set counterparty_account_id = p_account where id = p_id and user_id = v_uid;
end $$;
grant create on schema public to app_writer;
alter function public.set_transaction_counterparty(uuid, uuid) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.set_transaction_counterparty(uuid, uuid) from public, anon;
grant execute on function public.set_transaction_counterparty(uuid, uuid) to authenticated;
