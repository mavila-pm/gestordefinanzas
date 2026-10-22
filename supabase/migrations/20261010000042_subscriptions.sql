-- Mis suscripciones (Clever benchmark, PO): a subscription IS an obligation (fixed_expenses, kind = 'subscription'), so
-- planning, Próximos pagos, settlements and their real payment history stay one engine. Only what a subscription adds:
--   provider    catalogue slug for the logo/monogram (null = custom service); the catalogue lives in code.
--   card_id / account_id   how it is paid (optional, at most one), owned by the same person (composite FKs).
-- Price and date edits keep changing only the plan; real payments stay in plan_settlements → transactions.
alter table public.fixed_expenses
  add column provider text check (provider ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  add column card_id uuid,
  add column account_id uuid,
  add constraint fixed_expenses_one_instrument check (card_id is null or account_id is null),
  add constraint fixed_expenses_card_fk foreign key (card_id, user_id) references public.cards (id, user_id) on delete set null (card_id),
  add constraint fixed_expenses_account_fk foreign key (account_id, user_id) references public.accounts (id, user_id) on delete set null (account_id);
create index fixed_expenses_card on public.fixed_expenses (card_id) where card_id is not null;
create index fixed_expenses_account on public.fixed_expenses (account_id) where account_id is not null;
