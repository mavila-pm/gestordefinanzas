import type { Currency } from '../domain/money';

/**
 * Balance financiero (UX audit §2.3, CR-002): how the monthly income is assigned, per currency. Pure.
 *   ingreso base   = expected monthly income (recurring incomes normalized to a month) — "estimado"
 *   asignado       = límites por categoría + pagos fijos y membresías + cuotas de deudas + meta de ahorro + meta de inversión
 *   sin asignar    = ingreso base − asignado (negative = "te faltan"); unknown when the income base is unknown.
 * A goal is a fixed amount or a % of the income base; a % goal with an unknown income is unknown (never 0).
 * Nothing here is money moved: it is a plan. Only real movements change balances.
 */
export type Frequency = 'monthly' | 'semimonthly' | 'biweekly' | 'weekly';
const PER_MONTH: Record<Frequency, number> = { monthly: 1, semimonthly: 2, biweekly: 26 / 12, weekly: 52 / 12 };

export interface IncomeRow { currency: Currency; amountMinor: number | null; frequency: Frequency; endedOn?: string | null; pausedUntil?: string | null }
export interface Goal { mode: 'fixed' | 'percent'; amountMinor: number | null; bp: number | null }
export interface BalanceInput {
  currency: Currency;
  incomes: ReadonlyArray<IncomeRow>;
  /** Lima today: an ended income (endedOn ≤ today) or one paused past today does not count. */
  today: string;
  budgets: ReadonlyArray<{ currency: Currency; amountMinor: number }>;
  fixed: ReadonlyArray<{ currency: Currency; amountMinor: number | null; frequency: string }>;
  debts: ReadonlyArray<{ currency: Currency; installmentMinor: number | null; balanceMinor: number }>;
  savings: Goal | null;
  investment: Goal | null;
}
export interface BalanceLine { key: 'budgets' | 'fixed' | 'debts' | 'savings' | 'investment'; amountMinor: number | null; unknownCount: number }
export interface FinancialBalance {
  currency: Currency;
  incomeMinor: number | null;
  /** Recurring incomes whose amount is not known yet: the base is partial. */
  incomeUnknown: number;
  lines: BalanceLine[];
  assignedMinor: number;
  unassignedMinor: number | null;
  /**
   * What 'sin asignar' is: exact · at_most (every income known, some assigned amount unknown: the real remainder is
   * this or less) · partial (an income amount is unknown too) · unknown (no income base). Unknown is never 0.
   */
  unassignedKind: 'exact' | 'at_most' | 'partial' | 'unknown';
}

export function monthlyIncome(incomes: readonly IncomeRow[], currency: Currency, today: string): { amountMinor: number | null; unknown: number } {
  const of = incomes.filter((i) => i.currency === currency && !(i.endedOn && i.endedOn <= today) && !(i.pausedUntil && i.pausedUntil > today));
  const known = of.filter((i) => i.amountMinor !== null);
  return { amountMinor: known.length ? Math.round(known.reduce((s, i) => s + (i.amountMinor as number) * PER_MONTH[i.frequency], 0)) : null, unknown: of.length - known.length };
}

/** A % goal needs the whole income base: with an income whose amount is unknown, the goal is unknown too (never a part). */
export function goalAmount(g: Goal | null, income: { amountMinor: number | null; unknown: number }): number | null {
  if (!g) return null;
  if (g.mode === 'fixed') return g.amountMinor;
  return g.bp !== null && income.amountMinor !== null && income.unknown === 0 ? Math.round((income.amountMinor * g.bp) / 10000) : null;
}

/** Monthly equivalent of a fixed payment; one with another rhythm (yearly, every 2 or 3 months) is spread over the months. */
const FIXED_PER_MONTH: Record<string, number> = { monthly: 1, bimonthly: 1 / 2, quarterly: 1 / 3, yearly: 1 / 12 };

export function financialBalance(input: BalanceInput): FinancialBalance {
  const c = input.currency;
  const inc = monthlyIncome(input.incomes, c, input.today);
  const fixed = input.fixed.filter((f) => f.currency === c);
  const debts = input.debts.filter((d) => d.currency === c && d.balanceMinor > 0);
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  // Only unknown items (2 installments without amount): the line is unknown, never "0.00".
  const knownSum = (xs: number[]) => (xs.length ? sum(xs) : null);
  const savings = goalAmount(input.savings, inc);
  const investment = goalAmount(input.investment, inc);
  const lines: BalanceLine[] = [
    { key: 'budgets', amountMinor: sum(input.budgets.filter((b) => b.currency === c).map((b) => b.amountMinor)), unknownCount: 0 },
    { key: 'fixed', amountMinor: knownSum(fixed.filter((f) => f.amountMinor !== null).map((f) => Math.round((f.amountMinor as number) * (FIXED_PER_MONTH[f.frequency] ?? 1)))), unknownCount: fixed.filter((f) => f.amountMinor === null).length },
    { key: 'debts', amountMinor: knownSum(debts.filter((d) => d.installmentMinor !== null).map((d) => Math.min(d.installmentMinor as number, d.balanceMinor))), unknownCount: debts.filter((d) => d.installmentMinor === null).length },
    { key: 'savings', amountMinor: savings, unknownCount: input.savings && savings === null ? 1 : 0 },
    { key: 'investment', amountMinor: investment, unknownCount: input.investment && investment === null ? 1 : 0 },
  ];
  // A line with nothing in it (no fixed payments at all) is a real 0, not unknown.
  for (const l of lines) if (l.amountMinor === null && l.unknownCount === 0 && (l.key === 'fixed' || l.key === 'debts')) l.amountMinor = 0;
  const assignedMinor = sum(lines.map((l) => l.amountMinor ?? 0));
  const unassignedMinor = inc.amountMinor === null ? null : inc.amountMinor - assignedMinor;
  const unknownLines = lines.some((l) => l.unknownCount > 0);
  const unassignedKind = unassignedMinor === null ? 'unknown' : inc.unknown > 0 ? 'partial' : unknownLines ? 'at_most' : 'exact';
  return { currency: c, incomeMinor: inc.amountMinor, incomeUnknown: inc.unknown, lines, assignedMinor, unassignedMinor, unassignedKind };
}
