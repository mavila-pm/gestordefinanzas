-- Partial payments (ADR-0017). Planned ≠ paid: a real movement smaller than the planned amount is an abono (status
-- 'partial') and the occurrence stays open for what remains. There is no amount column: paid = Σ of the REAL linked
-- movements, never a typed number. An occurrence closes once — a 'paid' row (the person said "pago completo", or the
-- server saw the real total reach a confirmed plan) or a 'skipped' row — and nothing is linked to it after it closed.
-- A month with abonos is never skipped (the real money would vanish from the plan).
-- One real movement still settles at most one item (plan_settlements_transaction is kept), incomes stay one row per
-- period (plan_settlements_income_period is kept), and a partial is only ever a payment linked to a movement.
-- Debt abonos (ADR-0017 §D) get a small ledger (debt_payments) written only through record_debt_payment().
-- Contains two DROPs with no DROP-free equivalent: a CHECK expression cannot be changed in place (DROP CONSTRAINT),
-- and a partial unique index cannot change its predicate nor become a constraint (DROP INDEX). Both only remove
-- metadata and every new constraint holds on existing rows: paste it in the Supabase SQL Editor, see the runbook.

alter table public.plan_settlements drop constraint plan_settlements_status_check;
alter table public.plan_settlements add constraint plan_settlements_status_check check (status in ('paid', 'partial', 'skipped'));
alter table public.plan_settlements add constraint plan_settlements_partial_link
  check (status <> 'partial' or (fixed_expense_id is not null and transaction_id is not null));

-- Several abonos per occurrence; still exactly one closing row (paid or skipped).
drop index public.plan_settlements_obligation_period;
create unique index plan_settlements_obligation_closed on public.plan_settlements (fixed_expense_id, period)
  where fixed_expense_id is not null and status in ('paid', 'skipped');
-- Every row of an occurrence (abonos included), no predicate: the composite FK (fixed_expense_id, user_id) on a cascade
-- delete of a payment (the dropped index served it), and the guard's / settleObligation's reads by (payment, month).
create index plan_settlements_obligation on public.plan_settlements (fixed_expense_id, user_id, period);

-- Guard (migration 051) + the occurrence rules. Writes for the same (payment, month) are serialized with a
-- transaction-scoped advisory lock, so a request that waited sees a row committed meanwhile:
--   · a closing row (paid / skipped) already there → refused (23505, like the unique index);
--   · 'skipped' when the month has abonos, or carrying a movement → refused (23514): "Omitido" would hide real money.
create or replace function public.plan_settlements_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_tx record;
  v_currency public.currency_code;
begin
  if new.fixed_expense_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('plan_settlement:' || new.fixed_expense_id::text || ':' || new.period, 0));
    if exists (select 1 from public.plan_settlements s
               where s.fixed_expense_id = new.fixed_expense_id and s.user_id = new.user_id and s.period = new.period
                 and s.status in ('paid', 'skipped') and s.id <> new.id) then
      raise exception 'occurrence_closed' using errcode = '23505';
    end if;
    if new.status = 'skipped' and new.transaction_id is not null then
      raise exception 'skipped_with_movement' using errcode = '23514'; -- a real movement is an abono or the payment
    end if;
    if new.status = 'skipped' and exists (select 1 from public.plan_settlements s
               where s.fixed_expense_id = new.fixed_expense_id and s.user_id = new.user_id and s.period = new.period
                 and s.status = 'partial' and s.id <> new.id) then
      raise exception 'occurrence_has_abonos' using errcode = '23514';
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
-- Same trigger as 051 (period included: moving a row to a closed month is refused), so 052 stands on its own.
create or replace trigger plan_settlements_guard
  before insert or update of transaction_id, fixed_expense_id, expected_income_id, status, user_id, period on public.plan_settlements
  for each row execute function public.plan_settlements_guard();

-- ── Debt abonos (ADR-0017 §D) ─────────────────────────────────────────────────────────────────────────────
-- "Registrar pago" of a debt is one row here plus the debt update, in one transaction. The month's installment is
-- settled when that month's payments ADD UP to what was due (the installment, or the balance when it is smaller):
-- S/ 300 + S/ 200 settle a S/ 500 installment, and the plan reserves only what is left of it. A repeated submission
-- (same client_ref: a retry, a second tab) changes nothing. No movement is created: the real payment arrives (or was
-- registered) as a movement of its own. Clients read their rows; only the function writes them.
create table public.debt_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  debt_id uuid not null,
  -- Lima month of the payment (the installment it counts toward).
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  -- This payment completed the month's installment (counted once in debts.installments_paid).
  settles boolean not null default false,
  client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$'),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint debt_payments_debt_fk foreign key (debt_id, user_id) references public.debts (id, user_id) on delete cascade
);
-- The function's per-debt month total, and the composite FK on a cascade delete of a debt.
create index debt_payments_debt_period on public.debt_payments (debt_id, user_id, period);
-- The planning loader: the person's recent months.
create index debt_payments_user_period on public.debt_payments (user_id, period);
create unique index debt_payments_client_ref on public.debt_payments (user_id, client_ref) where client_ref is not null;
create unique index debt_payments_settles_once on public.debt_payments (debt_id, period) where settles;

alter table public.debt_payments enable row level security;
revoke all on public.debt_payments from public, anon, authenticated;
grant select on public.debt_payments to authenticated;
grant all on public.debt_payments to service_role;
create policy debt_payments_read on public.debt_payments for select to authenticated
  using (user_id = (select auth.uid()));
-- app_writer (migration 004: NOLOGIN, no bypassrls): exactly what record_debt_payment needs, own rows only.
grant select, insert on public.debt_payments to app_writer;
create policy debt_payments_writer on public.debt_payments for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));
grant select, update (balance_minor, installments_paid, last_payment_on) on public.debts to app_writer;
create policy debts_writer on public.debts for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

-- Returns what happened: the new balance, whether this payment settled the month's installment, what was due and
-- what the month's payments add up to (the screen says "De la cuota de este mes faltan S/ X").
create function public.record_debt_payment(p_debt_id uuid, p_amount_minor bigint, p_client_ref text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_today date := (now() at time zone 'America/Lima')::date;
  v_period text := to_char((now() at time zone 'America/Lima')::date, 'YYYY-MM');
  v_debt record;
  v_prev record;
  v_replay boolean := false;
  v_paid bigint;
  v_settled boolean;
  v_due bigint;
  v_settles boolean := false;
  v_balance bigint;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 100000000000 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_client_ref is not null and p_client_ref !~ '^[A-Za-z0-9:_-]{8,120}$' then raise exception 'invalid_ref' using errcode = '22023'; end if;
  -- The debt row lock serializes payments of the same debt: each one sees what the previous one committed.
  select d.id, d.currency, d.balance_minor, d.installment_minor, d.installments_paid, d.installments_total, d.last_payment_on
    into v_debt from public.debts d where d.id = p_debt_id and d.user_id = v_uid for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_client_ref is not null then
    select p.debt_id, p.amount_minor, p.period, p.settles into v_prev from public.debt_payments p where p.user_id = v_uid and p.client_ref = p_client_ref;
    v_replay := found;
    -- A replay is the same submission: another debt or amount under the same ref is refused, never answered as done.
    if v_replay and (v_prev.debt_id <> v_debt.id or v_prev.amount_minor <> p_amount_minor) then
      raise exception 'client_ref_conflict' using errcode = '23505';
    end if;
  end if;
  if v_replay then
    v_period := v_prev.period;
    v_settles := v_prev.settles;
  elsif p_amount_minor > v_debt.balance_minor then
    raise exception 'over_balance' using errcode = '23514';
  end if;
  select coalesce(sum(p.amount_minor), 0)::bigint, coalesce(bool_or(p.settles), false) into v_paid, v_settled
  from public.debt_payments p where p.debt_id = v_debt.id and p.user_id = v_uid and p.period = v_period;
  -- A payment registered before this ledger existed settled its month through last_payment_on.
  v_settled := v_settled or (v_debt.last_payment_on is not null and to_char(v_debt.last_payment_on, 'YYYY-MM') = v_period);
  v_balance := v_debt.balance_minor;
  if not v_replay then
    if v_debt.installment_minor is not null and not v_settled then
      -- Due this month: the installment, or what was owed at the start of the month when it is smaller.
      v_due := least(v_debt.installment_minor, v_debt.balance_minor + v_paid);
      v_settles := v_paid + p_amount_minor >= v_due;
    end if;
    insert into public.debt_payments (user_id, debt_id, period, amount_minor, settles, client_ref)
    values (v_uid, v_debt.id, v_period, p_amount_minor, v_settles, p_client_ref);
    v_balance := v_debt.balance_minor - p_amount_minor;
    update public.debts set
      balance_minor = v_balance,
      installments_paid = case when not v_settles then v_debt.installments_paid
        when v_debt.installments_total is null then v_debt.installments_paid + 1
        else least(v_debt.installments_paid + 1, v_debt.installments_total) end,
      last_payment_on = case when v_settles then v_today else v_debt.last_payment_on end
    where id = v_debt.id and user_id = v_uid;
    v_paid := v_paid + p_amount_minor;
    v_settled := v_settled or v_settles;
  elsif v_debt.installment_minor is not null and not v_settled then
    v_due := least(v_debt.installment_minor, v_debt.balance_minor + v_paid);
  end if;
  return jsonb_build_object('replay', v_replay, 'currency', v_debt.currency, 'balance_minor', v_balance, 'settles', v_settles,
    'period_settled', v_settled, 'due_minor', v_due, 'period_paid_minor', v_paid, 'installment_known', v_debt.installment_minor is not null);
end $$;
grant create on schema public to app_writer;
alter function public.record_debt_payment(uuid, bigint, text) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.record_debt_payment(uuid, bigint, text) from public, anon;
grant execute on function public.record_debt_payment(uuid, bigint, text) to authenticated;
