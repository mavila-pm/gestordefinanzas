-- TASK-013: dedupe must survive user corrections. What the source reported (amount, time) is kept in columns that
-- no correction can change; cross-source matching compares against BOTH the current and the reported values, so a
-- late SMS of a movement whose amount the user corrected is merged (or flagged), never counted twice.
alter table public.transactions
  add column reported_amount_minor bigint check (reported_amount_minor > 0),
  add column reported_occurred_at timestamptz;
update public.transactions set reported_amount_minor = amount_minor, reported_occurred_at = occurred_at
  where reported_amount_minor is null;
alter table public.transactions alter column reported_amount_minor set not null, alter column reported_occurred_at set not null;
create index transactions_dedupe_reported on public.transactions (user_id, institution_code, reported_amount_minor, currency, reported_occurred_at);

create function public.keep_reported_values() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.reported_amount_minor := coalesce(new.reported_amount_minor, new.amount_minor);
    new.reported_occurred_at := coalesce(new.reported_occurred_at, new.occurred_at);
  else
    -- Immutable for everyone, including the audited write functions.
    new.reported_amount_minor := old.reported_amount_minor;
    new.reported_occurred_at := old.reported_occurred_at;
  end if;
  return new;
end $$;
revoke execute on function public.keep_reported_values() from public, anon, authenticated;
create trigger transactions_reported_values before insert or update on public.transactions
  for each row execute function public.keep_reported_values();
