-- FRONT A (performance advisor, 2026-10-20: unindexed_foreign_keys ×14). Only one of the 14 needs a new index; the
-- others are already served by an index on the FK's own column, or the parent is never deleted. No data touched.
--
-- Needed: transaction_allocations.category_id → categories. "Quitar categoría" (deleteCategoryAction) deletes a row
-- of categories; the FK check then looks for allocations with that category_id. No index starts with category_id,
-- so every category delete scanned the allocations of every person. The other FKs to categories
-- (transactions, fixed_expenses, budgets, merchant_rules) are already indexed.
create index if not exists transaction_allocations_category on public.transaction_allocations (category_id);

-- Kept as they are (advisor INFO accepted; guarded by tests/db/fk-indexes.test.ts):
-- * card_statements (card_id, user_id), fixed_expenses (account_id|card_id, user_id), plan_settlements
--   (expected_income_id|fixed_expense_id|transaction_id, user_id): served by existing indexes that start with the FK's
--   own column (card_statements_card_id_cut_date_key, fixed_expenses_account/_card, plan_settlements_* uniques).
--   The advisor only accepts an index with exactly the FK columns in FK order; a second copy would only cost writes.
-- * plan_applications (base_transaction_id, user_id) and (supersedes_id, user_id), user_preferences
--   (primary_account_id, user_id): the FK check filters on user_id too, served by plan_applications_user and the
--   user_preferences primary key (a few rows per person).
-- * legal_acceptances (kind, version) → legal_documents and *.institution_code → institutions: reference tables
--   that are never deleted or re-keyed.
