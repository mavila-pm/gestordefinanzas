-- Settlement guard (ADR-0017): a planned item is settled only by a real movement that can pay it, whatever the
-- write path (Dinero disponible, Próximos pagos, a Vels button, a client calling the API directly). The server checks
-- the same rules first (lib/settlements.ts); this is the floor every path shares.
--   · the movement is confirmed: a pending, review or duplicate movement never settles anything;
--   · a payment is settled by an outgoing movement that is not an income, in the payment's own currency (PEN ≠ USD);
--   · an expected income is settled by an income movement in the income's own currency.
-- A parent that is not visible here (another person's obligation or movement) is left to the composite FKs and RLS,
-- which reject it with their own codes (23503 / 42501). Existing rows are not re-checked (live check 2026-10-20: 0
-- rows would violate it); updates re-check only when the link itself changes (variance_ack edits do not). `period` is
-- part of the link: moving a row to another month is a new settlement of that month.
create function public.plan_settlements_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_tx record;
  v_currency public.currency_code;
begin
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

create trigger plan_settlements_guard
  before insert or update of transaction_id, fixed_expense_id, expected_income_id, status, user_id, period on public.plan_settlements
  for each row execute function public.plan_settlements_guard();
