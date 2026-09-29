-- Idempotent creates (ADR-0012): a double submit, two tabs or a retried request must not duplicate a financial row.
-- The client/server sends a per-submission reference; the same reference for the same user is stored once.
alter table public.fixed_expenses add column client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$');
alter table public.debts add column client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$');
alter table public.expected_incomes add column client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$');
alter table public.accounts add column client_ref text check (client_ref ~ '^[A-Za-z0-9:_-]{8,120}$');
create unique index fixed_expenses_client_ref on public.fixed_expenses (user_id, client_ref) where client_ref is not null;
create unique index debts_client_ref on public.debts (user_id, client_ref) where client_ref is not null;
create unique index expected_incomes_client_ref on public.expected_incomes (user_id, client_ref) where client_ref is not null;
create unique index accounts_client_ref on public.accounts (user_id, client_ref) where client_ref is not null;
