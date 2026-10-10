-- Performance hardening flagged by Supabase advisors (no permission changes).
-- 1) RLS filters every query by user_id: index it on every user-owned table and cover the
--    composite (…, user_id) FKs used for cascades and joins.
create index if not exists accounts_user on public.accounts (user_id);
create index if not exists cards_user on public.cards (user_id);
create index if not exists merchant_rules_user on public.merchant_rules (user_id);
create index if not exists merchant_rules_category on public.merchant_rules (category_id);
create index if not exists transaction_sources_tx on public.transaction_sources (transaction_id, user_id);
create index if not exists financial_events_tx on public.financial_events (transaction_id, user_id) where transaction_id is not null;
create index if not exists transactions_card on public.transactions (card_id, user_id) where card_id is not null;
create index if not exists transactions_account on public.transactions (account_id, user_id) where account_id is not null;
create index if not exists transactions_original on public.transactions (original_transaction_id, user_id) where original_transaction_id is not null;
create index if not exists transactions_duplicate_of on public.transactions (duplicate_of_id, user_id) where duplicate_of_id is not null;
create index if not exists transactions_category on public.transactions (category_id);

-- 2) categories had two permissive SELECT policies (read + "for all" write). Split write by command
--    so SELECT is evaluated by a single policy. Same semantics as before.
drop policy categories_write on public.categories;
create policy categories_insert on public.categories for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy categories_update on public.categories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy categories_delete on public.categories for delete to authenticated
  using (user_id = (select auth.uid()));
