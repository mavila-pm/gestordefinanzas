import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../src/infrastructure/supabase/transaction-row';
import type { Transaction } from '../src/domain/types';
import { parseIngestionCodes } from '../src/engine/review-reasons';

/** Read helpers for the signed-in user. They run with the user's session: RLS scopes every query. */

export interface CategoryOption { id: string; name: string; own: boolean }
export interface CardOption { id: string; alias: string; institution: string | null; kind: 'credit' | 'debit'; currency: string; last4: string }
export interface AccountOption { id: string; alias: string; institution: string | null; last4: string | null }

export interface Catalog {
  categories: CategoryOption[];
  cards: CardOption[];
  accounts: AccountOption[];
}

export async function loadCatalog(supabase: SupabaseClient): Promise<Catalog> {
  const [cat, cards, accounts] = await Promise.all([
    supabase.from('categories').select('id,name,user_id').order('name'),
    supabase.from('cards').select('id,alias,institution_code,kind,currency,last4').eq('active', true).order('created_at'),
    supabase.from('accounts').select('id,alias,institution_code,last4').order('created_at'),
  ]);
  return {
    categories: (cat.data ?? []).map((c) => ({ id: c.id, name: c.name, own: c.user_id !== null })),
    cards: (cards.data ?? []).map((c) => ({ id: c.id, alias: c.alias, institution: c.institution_code, kind: c.kind, currency: c.currency, last4: c.last4 })),
    accounts: (accounts.data ?? []).map((a) => ({ id: a.id, alias: a.alias, institution: a.institution_code, last4: a.last4 })),
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
