import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../src/infrastructure/supabase/transaction-row';
import type { Transaction } from '../src/domain/types';
import { parseIngestionCodes } from '../src/engine/review-reasons';
import { buildUserContext } from '../src/engine/user-context';
import type { UserContext } from '../src/engine/ingest';

/** Read helpers for the signed-in user. They run with the user's session: RLS scopes every query. */

export interface CategoryOption { id: string; name: string; own: boolean }
export interface CardOption { id: string; alias: string; institution: string | null; kind: 'credit' | 'debit'; currency: string; last4: string; active: boolean }
export interface AccountOption { id: string; alias: string; institution: string | null; currency: string; last4: string | null; active: boolean }

export interface Catalog {
  categories: CategoryOption[];
  cards: CardOption[];
  accounts: AccountOption[];
}

export async function loadCatalog(supabase: SupabaseClient): Promise<Catalog> {
  const [cat, cards, accounts] = await Promise.all([
    supabase.from('categories').select('id,name,user_id').order('name'),
    supabase.from('cards').select('id,alias,institution_code,kind,currency,last4,active').order('created_at'),
    supabase.from('accounts').select('id,alias,institution_code,currency,last4,active').order('created_at'),
  ]);
  return {
    categories: (cat.data ?? []).map((c) => ({ id: c.id, name: c.name, own: c.user_id !== null })),
    cards: (cards.data ?? []).map((c) => ({ id: c.id, alias: c.alias, institution: c.institution_code, kind: c.kind, currency: c.currency, last4: c.last4, active: c.active })),
    accounts: (accounts.data ?? []).map((a) => ({ id: a.id, alias: a.alias, institution: a.institution_code, currency: a.currency, last4: a.last4, active: a.active })),
  };
}

export interface TransactionWithLinks extends Transaction {
  categoryId: string | null;
  cardId: string | null;
  accountId: string | null;
}

export const LINKED_SELECT = `${TRANSACTION_SELECT},category_id,card_id,account_id`;

export function toLinked(r: TransactionRow & { category_id: string | null; card_id: string | null; account_id: string | null }): TransactionWithLinks {
  return { ...rowToTransaction(r), categoryId: r.category_id, cardId: r.card_id, accountId: r.account_id };
}

/** Codes the parser/engine recorded when each transaction was ingested (financial_events.detail). */
export async function ingestionCodesFor(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { data } = await supabase
    .from('financial_events')
    .select('transaction_id,detail,outcome')
    .in('transaction_id', ids)
    .in('outcome', ['created', 'possible_duplicate']);
  for (const e of data ?? []) {
    out.set(e.transaction_id, [...(out.get(e.transaction_id) ?? []), ...parseIngestionCodes(e.detail)]);
  }
  return out;
}

export const REVIEW_STATUSES = ['review_required', 'possible_duplicate'] as const;

/** Only active cards/accounts are offered for new links; inactive ones still resolve names in history. */
export function activeOnly<T extends { active: boolean }>(items: T[]): T[] {
  return items.filter((i) => i.active);
}

export interface RuleRow { id: string; contains: string; category: string | null; createdAt: string }

export async function loadRules(supabase: SupabaseClient): Promise<RuleRow[]> {
  const { data } = await supabase.from('merchant_rules').select('id,contains,created_at,category:categories(name)').order('contains');
  return (data ?? []).map((r) => ({ id: r.id, contains: r.contains, createdAt: r.created_at,
    category: (r.category as unknown as { name: string } | null)?.name ?? null }));
}

/** Ingestion context (cards, own accounts, learned rules) read under the user's session. */
export async function loadUserContext(supabase: SupabaseClient, userId: string): Promise<UserContext> {
  const [cards, accounts, rules] = await Promise.all([
    supabase.from('cards').select('last4,kind,active'),
    supabase.from('accounts').select('last4,active'),
    supabase.from('merchant_rules').select('contains,category:categories(name)'),
  ]);
  return buildUserContext(userId, {
    cards: cards.data ?? [],
    accounts: accounts.data ?? [],
    rules: (rules.data ?? []).map((r) => ({ contains: r.contains, category_name: (r.category as unknown as { name: string } | null)?.name ?? null })),
  });
}

export interface BudgetRow { id: string; categoryId: string; category: string; currency: 'PEN' | 'USD'; amountMinor: number }

export async function loadBudgets(supabase: SupabaseClient): Promise<BudgetRow[]> {
  const { data } = await supabase.from('budgets').select('id,category_id,currency,amount_minor,category:categories(name)').order('created_at');
  return (data ?? []).map((b) => ({ id: b.id, categoryId: b.category_id, currency: b.currency, amountMinor: Number(b.amount_minor),
    category: (b.category as unknown as { name: string } | null)?.name ?? '—' }));
}
