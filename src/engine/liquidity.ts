import { balanceEffect } from '../domain/balance-effect';
import type { Currency } from '../domain/money';
import type { TransactionStatus, TransactionType } from '../domain/types';

/**
 * Liquidity (ADR-0020): how much money the person has today, per currency, derived from what they registered in
 * Cuentas y tarjetas instead of one declared total. Pure.
 *
 *   account balance = its latest checkpoint ("saldo al <fecha>") + Σ balance deltas of CONFIRMED movements that
 *                     occurred after it. No checkpoint → unknown (null), never 0.
 *   liquidity       = Σ known balances of active bank + cash accounts of ONE currency (PEN ≠ USD, never converted).
 *
 * Never liquidity: a credit card's available line, investments, debts, goals. Credit "used" is derived the same way
 * from its own checkpoints (purchases add, payments and refunds subtract).
 * Until a person has at least one account with a balance in a currency, the latest declared total (legacy
 * balance_snapshots) is used for that currency — the two sources are never added together.
 * Movements in review or flagged as possible duplicates do not count yet; they are reported as pending.
 */
export interface LiquidityAccount { id: string; alias: string; kind: 'bank' | 'cash'; currency: Currency; active: boolean }
export interface Checkpoint { ownerId: string; amountMinor: number; asOf: string }
export interface LiquidityTx {
  id: string; type: TransactionType; status: TransactionStatus; amountMinor: number; currency: Currency; occurredAt: string;
  accountId: string | null; counterpartyAccountId?: string | null; cardId: string | null;
}
export interface LiquidityCard { id: string; kind: 'credit' | 'debit'; currency: Currency }
export interface DeclaredBalance { currency: Currency; amountMinor: number; bankMinor: number | null; cashMinor: number | null; asOf: string }

export type LiquidityMissing =
  | { code: 'account_balance'; accountId: string; alias: string }
  | { code: 'transfer_destination' | 'cash_destination'; txId: string; amountMinor: number };

export interface AccountBalance { id: string; alias: string; kind: 'bank' | 'cash'; balanceMinor: number | null; asOf: string | null }

export interface Liquidity {
  currency: Currency;
  /** 'accounts' = derived from registered accounts · 'declared' = last stated total · null = nothing known. */
  source: 'accounts' | 'declared' | null;
  totalMinor: number | null;
  bankMinor: number | null;
  cashMinor: number | null;
  accounts: AccountBalance[];
  /** Movements touching these accounts that are still in review (not counted yet). */
  pendingCount: number;
  missing: LiquidityMissing[];
  /** complete = every active account known · partial = some missing · unknown = nothing to show. */
  status: 'complete' | 'partial' | 'unknown';
  asOf: string | null;
}

const PENDING: TransactionStatus[] = ['review_required', 'possible_duplicate'];

/** Latest checkpoint per owner (account or card): the one with the greatest asOf. */
export function latestCheckpoints(cps: Checkpoint[]): Map<string, Checkpoint> {
  const out = new Map<string, Checkpoint>();
  for (const cp of cps) {
    const cur = out.get(cp.ownerId);
    if (!cur || Date.parse(cp.asOf) > Date.parse(cur.asOf)) out.set(cp.ownerId, cp);
  }
  return out;
}

const after = (tx: LiquidityTx, cp: Checkpoint) => Date.parse(tx.occurredAt) > Date.parse(cp.asOf);

export function liquidity(input: {
  currency: Currency;
  accounts: LiquidityAccount[];
  checkpoints: Checkpoint[];
  txs: LiquidityTx[];
  cards: LiquidityCard[];
  declared: DeclaredBalance | null;
}): Liquidity {
  const { currency } = input;
  const accounts = input.accounts.filter((a) => a.active && a.currency === currency);
  const ids = new Set(accounts.map((a) => a.id));
  const latest = latestCheckpoints(input.checkpoints.filter((c) => ids.has(c.ownerId)));
  const cardKind = new Map(input.cards.map((c) => [c.id, c.kind]));
  const balances = new Map<string, number>();
  for (const [id, cp] of latest) balances.set(id, cp.amountMinor);
  const missing: LiquidityMissing[] = [];
  let pendingCount = 0;

  for (const tx of input.txs) {
    if (tx.currency !== currency) continue; // a USD movement never touches a soles account
    const touches = (tx.accountId && ids.has(tx.accountId)) || (tx.counterpartyAccountId && ids.has(tx.counterpartyAccountId));
    if (!touches) continue;
    if (PENDING.includes(tx.status)) { pendingCount += 1; continue; }
    if (tx.status !== 'confirmed') continue;
    const eff = balanceEffect({ ...tx, cardKind: tx.cardId ? cardKind.get(tx.cardId) ?? null : null });
    let applied = false;
    for (const d of eff.accounts) {
      const cp = latest.get(d.accountId);
      if (!cp || !after(tx, cp)) continue; // before the checkpoint: already inside the stated balance
      balances.set(d.accountId, (balances.get(d.accountId) ?? 0) + d.deltaMinor);
      applied = true;
    }
    if (applied && (eff.missing === 'transfer_destination' || eff.missing === 'cash_destination')) {
      missing.push({ code: eff.missing, txId: tx.id, amountMinor: tx.amountMinor });
    }
  }

  const list: AccountBalance[] = accounts.map((a) => ({
    id: a.id, alias: a.alias, kind: a.kind, balanceMinor: balances.has(a.id) ? balances.get(a.id)! : null, asOf: latest.get(a.id)?.asOf ?? null,
  }));
  const known = list.filter((a) => a.balanceMinor !== null);
  if (known.length > 0) {
    for (const a of list) if (a.balanceMinor === null) missing.unshift({ code: 'account_balance', accountId: a.id, alias: a.alias });
    const sum = (k: 'bank' | 'cash') => {
      const of = known.filter((a) => a.kind === k);
      return of.length ? of.reduce((s, a) => s + (a.balanceMinor as number), 0) : null;
    };
    const bankMinor = sum('bank');
    const cashMinor = sum('cash');
    const asOf = known.map((a) => a.asOf as string).sort().at(0) ?? null;
    return {
      currency, source: 'accounts', totalMinor: (bankMinor ?? 0) + (cashMinor ?? 0), bankMinor, cashMinor, accounts: list, pendingCount,
      missing, status: missing.length ? 'partial' : 'complete', asOf,
    };
  }
  const d = input.declared && input.declared.currency === currency ? input.declared : null;
  if (d) {
    return {
      currency, source: 'declared', totalMinor: d.amountMinor, bankMinor: d.bankMinor, cashMinor: d.cashMinor, accounts: list, pendingCount: 0,
      missing: [], status: 'complete', asOf: d.asOf,
    };
  }
  return { currency, source: null, totalMinor: null, bankMinor: null, cashMinor: null, accounts: list, pendingCount, missing: [], status: 'unknown', asOf: null };
}

/**
 * A credit card's used line today: latest "used" checkpoint + purchases − payments/refunds after it (confirmed only,
 * same currency). Unknown without a checkpoint. Negative = saldo a favor (never liquidity). Available = línea − used.
 */
export function cardUsed(card: { id: string; currency: Currency; creditLimitMinor: number | null }, checkpoints: Checkpoint[], txs: LiquidityTx[]):
  { usedMinor: number | null; availableMinor: number | null; asOf: string | null } {
  const cp = latestCheckpoints(checkpoints.filter((c) => c.ownerId === card.id)).get(card.id);
  if (!cp) return { usedMinor: null, availableMinor: null, asOf: null };
  let used = cp.amountMinor;
  for (const tx of txs) {
    if (tx.cardId !== card.id || tx.currency !== card.currency || tx.status !== 'confirmed' || !after(tx, cp)) continue;
    const eff = balanceEffect({ ...tx, cardKind: 'credit' });
    if (eff.cardUsed) used += eff.cardUsed.deltaMinor;
  }
  return { usedMinor: used, availableMinor: card.creditLimitMinor === null ? null : Math.max(0, card.creditLimitMinor - used), asOf: cp.asOf };
}
