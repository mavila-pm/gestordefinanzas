-- Money today with its breakdown (onboarding: "S/ 4,000 en mis cuentas y S/ 150 en efectivo"). amount_minor stays
-- the total the engine uses; bank_minor / cash_minor keep what the person said. Both null = no breakdown (a part
-- not said stays null, never 0). When both are present they must add up to the total (never two different truths).
-- Same table, RLS (own rows) and grants (select, insert) as before.
alter table public.balance_snapshots
  add column bank_minor bigint check (bank_minor between 0 and 100000000000),
  add column cash_minor bigint check (cash_minor between 0 and 100000000000),
  add constraint balance_snapshots_breakdown_sum check (bank_minor is null or cash_minor is null or bank_minor + cash_minor = amount_minor);
comment on column public.balance_snapshots.bank_minor is 'Part of the total held in bank accounts, as stated by the person (minor units). Null = not said.';
comment on column public.balance_snapshots.cash_minor is 'Part of the total held in cash, as stated by the person (minor units). Null = not said.';
