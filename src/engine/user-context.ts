import type { CardKind } from '../domain/types';
import { CATEGORIES, normalizeMerchant, type Category } from './categorizer';
import type { UserContext } from './ingest';

/** Rows as read (under RLS) from cards, accounts and merchant_rules + categories. */
export interface UserContextRows {
  cards: ReadonlyArray<{ last4: string; kind: CardKind; active?: boolean | null }>;
  accounts: ReadonlyArray<{ last4: string | null; active?: boolean | null }>;
  rules: ReadonlyArray<{ contains: string; category_name: string | null }>;
}

/**
 * Builds the ingestion context from the user's own data: registered cards (credit vs debit), own accounts
 * (to prove internal transfers, spec §18) and learned merchant rules (spec §22-23). Inactive items and rules
 * pointing to unknown categories are ignored rather than guessed.
 */
export function buildUserContext(userId: string, rows: UserContextRows): UserContext {
  const cards = rows.cards.filter((c) => c.active !== false && /^\d{4}$/.test(c.last4)).map((c) => ({ last4: c.last4, kind: c.kind }));
  const ownAccountLast4 = [...new Set(rows.accounts.filter((a) => a.active !== false && a.last4 && /^\d{4}$/.test(a.last4)).map((a) => a.last4!))];
  const merchantRules = rows.rules
    .filter((r) => CATEGORIES.includes(r.category_name as Category) && (normalizeMerchant(r.contains)?.length ?? 0) >= 3)
    .map((r) => ({ contains: r.contains, category: r.category_name as Category }))
    // Most specific (longest) rule first, so "UBER EATS" wins over "UBER".
    .sort((a, b) => b.contains.length - a.contains.length);
  return { userId, ownAccountLast4, cards, merchantRules };
}
