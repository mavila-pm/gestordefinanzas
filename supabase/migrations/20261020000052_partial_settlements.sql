-- Partial payments (ADR-0017). Planned ≠ paid: a real movement smaller than the planned amount is an abono (status
-- 'partial') and the occurrence stays open for what remains. There is no amount column: paid = Σ of the REAL linked
-- movements, never a typed number. An occurrence closes once — a 'paid' row (the person said "pago completo", or the
-- server saw the real total reach the plan) or a 'skipped' row — and nothing is linked to it after it closed.
-- One real movement still settles at most one item (plan_settlements_transaction is kept), incomes stay one row per
-- period (plan_settlements_income_period is kept), and a partial is only ever a payment linked to a movement.
-- Contains DROP: paste it in the Supabase SQL Editor (the connector cannot confirm it), see the runbook.

alter table public.plan_settlements drop constraint plan_settlements_status_check;
alter table public.plan_settlements add constraint plan_settlements_status_check check (status in ('paid', 'partial', 'skipped'));
alter table public.plan_settlements add constraint plan_settlements_partial_link
  check (status <> 'partial' or (fixed_expense_id is not null and transaction_id is not null));

-- Several abonos per occurrence; still exactly one closing row (paid or skipped).
drop index public.plan_settlements_obligation_period;
create unique index plan_settlements_obligation_closed on public.plan_settlements (fixed_expense_id, period)
  where fixed_expense_id is not null and status in ('paid', 'skipped');

-- Guard (migration 051) + the occurrence rule. Writes for the same (payment, month) are serialized with a
-- transaction-scoped advisory lock, so a request that waited sees a closing row committed meanwhile and is refused
-- (23505, like the unique index) instead of adding an abono to an occurrence that is already closed.
create or replace function public.plan_settlements_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_tx record;
  v_currency public.currency_code;
begin
  if new.fixed_expense_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('plan_settlement:' || new.fixed_expense_id::text || ':' || new.period, 0));
    if exists (select 1 from public.plan_settlements s
               where s.fixed_expense_id = new.fixed_expense_id and s.period = new.period
                 and s.status in ('paid', 'skipped') and s.id <> new.id) then
      raise exception 'occurrence_closed' using errcode = '23505';
    end if;
  end if;
  if new.transaction_id is null then return new; end if;
  select t.status, t.direction, t.type, t.currency into v_tx
  from public.transactions t where t.id = new.transaction_id and t.user_id = new.user_id;
  if not found then return new; end if;
  if v_tx.status <> 'confirmed' then
    raise exception 'settlement_tx_not_confirmed' using errcode = '23514';
  end if;
  if new.fixed_expense_id is not null then
    select f.currency into v_currency from public.fixed_expenses f where f.id = new.fixed_expense_id and f.user_id = new.user_id;
    if not found then return new; end if;
    if v_tx.direction <> 'outflow' or v_tx.type in ('income', 'deposit') or v_tx.currency <> v_currency then
      raise exception 'settlement_tx_cannot_pay' using errcode = '23514';
    end if;
  elsif new.expected_income_id is not null then
    select i.currency into v_currency from public.expected_incomes i where i.id = new.expected_income_id and i.user_id = new.user_id;
    if not found then return new; end if;
    if v_tx.type <> 'income' or v_tx.currency <> v_currency then
      raise exception 'settlement_tx_not_income' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.plan_settlements_guard() from public, anon, authenticated;
