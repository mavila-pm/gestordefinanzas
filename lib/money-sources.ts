import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import type { TransactionStatus, TransactionType } from '../src/domain/types';
import { cardUsed, liquidity, type Checkpoint, type DeclaredBalance, type Liquidity, type LiquidityTx } from '../src/engine/liquidity';

/**
 * Cuentas y tarjetas with their balances (ADR-0020), read under the person's session (RLS). Liquidity per currency is
 * computed by the pure engine from checkpoints + confirmed movements after them; the latest declared total
 * (balance_snapshots) is the fallback while no account has a balance in that currency.
 */
export interface SourceAccount {
  id: string; alias: string; kind: 'bank' | 'cash'; currency: Currency; active: boolean;
  institution: string | null; bankName: string | null; last4: string | null; cardId: string | null;
  balanceMinor: number | null; balanceAsOf: string | null;
}
export interface SourceCard {
  id: string; alias: string; kind: 'credit' | 'debit'; currency: Currency; active: boolean; institution: string | null; bankName: string | null;
  last4: string; color: string | null; expiryMonth: number | null; expiryYear: number | null;
  creditLimitMinor: number | null; statementDay: number | null; paymentDay: number | null;
  usedMinor: number | null; availableMinor: number | null; usedAsOf: string | null;
}
export interface MoneySources { accounts: SourceAccount[]; cards: SourceCard[]; liquidity: Record<Currency, Liquidity> }

const CURRENCIES: Currency[] = ['PEN', 'USD'];
/** Movements read for balances: enough for any person between two checkpoints; past it the balance says "parcial". */
const TX_LIMIT = 5000;

export async function loadMoneySources(supabase: SupabaseClient): Promise<MoneySources> {
  const [acc, cards, links, cps, used, snaps] = await Promise.all([
    supabase.from('accounts').select('id,alias,kind,currency,active,institution_code,bank_name,last4').order('created_at'),
    supabase.from('cards').select('id,alias,kind,currency,active,institution_code,bank_name,last4,color,expiry_month,expiry_year,credit_limit_minor,statement_day,payment_day').order('created_at'),
    supabase.from('card_accounts').select('card_id,account_id'),
    supabase.from('account_balance_checkpoints').select('account_id,amount_minor,as_of').order('as_of', { ascending: false }).limit(500),
    supabase.from('card_used_checkpoints').select('card_id,used_minor,as_of').order('as_of', { ascending: false }).limit(200),
    supabase.from('balance_snapshots').select('currency,amount_minor,bank_minor,cash_minor,as_of').order('as_of', { ascending: false }).limit(20),
  ]);
  const accCps: Checkpoint[] = (cps.data ?? []).map((r) => ({ ownerId: r.account_id, amountMinor: Number(r.amount_minor), asOf: r.as_of }));
  const usedCps: Checkpoint[] = (used.data ?? []).map((r) => ({ ownerId: r.card_id, amountMinor: Number(r.used_minor), asOf: r.as_of }));
  // Movements after the oldest checkpoint still in use (the latest one per account / card).
  const latestPer = new Map<string, string>();
  for (const c of [...accCps, ...usedCps]) if (!latestPer.has(c.ownerId) || c.asOf > latestPer.get(c.ownerId)!) latestPer.set(c.ownerId, c.asOf);
  const since = [...latestPer.values()].sort()[0] ?? null;
  const txRows = since
    ? (await supabase.from('transactions').select('id,type,status,amount_minor,currency,occurred_at,account_id,card_id')
      .gt('occurred_at', since).order('occurred_at', { ascending: false }).limit(TX_LIMIT)).data ?? []
    : [];
  const txs: LiquidityTx[] = txRows.map((t) => ({
    id: t.id, type: t.type as TransactionType, status: t.status as TransactionStatus, amountMinor: Number(t.amount_minor), currency: t.currency as Currency,
    occurredAt: t.occurred_at, accountId: t.account_id, cardId: t.card_id,
  }));
  const cardRows = cards.data ?? [];
  const engineCards = cardRows.map((c) => ({ id: c.id, kind: c.kind as 'credit' | 'debit', currency: c.currency as Currency }));
  const accountRows = (acc.data ?? []).map((a) => ({ id: a.id, alias: a.alias, kind: (a.kind ?? 'bank') as 'bank' | 'cash', currency: a.currency as Currency, active: a.active }));
  const declared = (cur: Currency): DeclaredBalance | null => {
    const s = (snaps.data ?? []).find((r) => r.currency === cur);
    return s ? { currency: cur, amountMinor: Number(s.amount_minor), bankMinor: s.bank_minor === null ? null : Number(s.bank_minor), cashMinor: s.cash_minor === null ? null : Number(s.cash_minor), asOf: s.as_of } : null;
  };
  const liq = Object.fromEntries(CURRENCIES.map((cur) => [cur, liquidity({ currency: cur, accounts: accountRows, checkpoints: accCps, txs, cards: engineCards, declared: declared(cur) })])) as Record<Currency, Liquidity>;
  const balanceOf = new Map(CURRENCIES.flatMap((cur) => liq[cur].accounts.map((a) => [a.id, a] as const)));
  const cardOf = new Map((links.data ?? []).map((l) => [l.account_id, l.card_id]));
  return {
    accounts: (acc.data ?? []).map((a) => ({
      id: a.id, alias: a.alias, kind: (a.kind ?? 'bank') as 'bank' | 'cash', currency: a.currency as Currency, active: a.active,
      institution: a.institution_code, bankName: a.bank_name, last4: a.last4, cardId: cardOf.get(a.id) ?? null,
      balanceMinor: balanceOf.get(a.id)?.balanceMinor ?? null, balanceAsOf: balanceOf.get(a.id)?.asOf ?? null,
    })),
    cards: cardRows.map((c) => {
      const limit = c.credit_limit_minor === null ? null : Number(c.credit_limit_minor);
      const u = c.kind === 'credit' ? cardUsed({ id: c.id, currency: c.currency as Currency, creditLimitMinor: limit }, usedCps, txs) : { usedMinor: null, availableMinor: null, asOf: null };
      return {
        id: c.id, alias: c.alias, kind: c.kind as 'credit' | 'debit', currency: c.currency as Currency, active: c.active, institution: c.institution_code, bankName: c.bank_name,
        last4: c.last4, color: c.color, expiryMonth: c.expiry_month, expiryYear: c.expiry_year, creditLimitMinor: limit, statementDay: c.statement_day, paymentDay: c.payment_day,
        usedMinor: u.usedMinor, availableMinor: u.availableMinor, usedAsOf: u.asOf,
      };
    }),
    liquidity: liq,
  };
}
