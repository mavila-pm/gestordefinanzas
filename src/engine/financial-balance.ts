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

export interface Goal { mode: 'fixed' | 'percent'; amountMinor: number | null; bp: number | null }
export interface BalanceInput {
  currency: Currency;
  incomes: ReadonlyArray<{ currency: Currency; amountMinor: number | null; frequency: Frequency }>;
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
}

export function monthlyIncome(incomes: BalanceInput['incomes'], currency: Currency): { amountMinor: number | null; unknown: number } {
  const of = incomes.filter((i) => i.currency === currency);
  const known = of.filter((i) => i.amountMinor !== null);
  return { amountMinor: known.length ? Math.round(known.reduce((s, i) => s + (i.amountMinor as number) * PER_MONTH[i.frequency], 0)) : null, unknown: of.length - known.length };
}

export function goalAmount(g: Goal | null, incomeMinor: number | null): number | null {
  if (!g) return null;
  if (g.mode === 'fixed') return g.amountMinor;
  return g.bp !== null && incomeMinor !== null ? Math.round((incomeMinor * g.bp) / 10000) : null;
}

/** Monthly equivalent of a fixed payment; one with another rhythm (yearly, every 2 or 3 months) is spread over the months. */
const FIXED_PER_MONTH: Record<string, number> = { monthly: 1, bimonthly: 1 / 2, quarterly: 1 / 3, yearly: 1 / 12 };

export function financialBalance(input: BalanceInput): FinancialBalance {
  const c = input.currency;
  const inc = monthlyIncome(input.incomes, c);
  const fixed = input.fixed.filter((f) => f.currency === c);
  const debts = input.debts.filter((d) => d.currency === c && d.balanceMinor > 0);
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const savings = goalAmount(input.savings, inc.amountMinor);
  const investment = goalAmount(input.investment, inc.amountMinor);
  const lines: BalanceLine[] = [
    { key: 'budgets', amountMinor: sum(input.budgets.filter((b) => b.currency === c).map((b) => b.amountMinor)), unknownCount: 0 },
    { key: 'fixed', amountMinor: sum(fixed.filter((f) => f.amountMinor !== null).map((f) => Math.round((f.amountMinor as number) * (FIXED_PER_MONTH[f.frequency] ?? 1)))), unknownCount: fixed.filter((f) => f.amountMinor === null).length },
    { key: 'debts', amountMinor: sum(debts.filter((d) => d.installmentMinor !== null).map((d) => Math.min(d.installmentMinor as number, d.balanceMinor))), unknownCount: debts.filter((d) => d.installmentMinor === null).length },
    { key: 'savings', amountMinor: savings, unknownCount: input.savings && savings === null ? 1 : 0 },
    { key: 'investment', amountMinor: investment, unknownCount: input.investment && investment === null ? 1 : 0 },
  ];
  const assignedMinor = sum(lines.map((l) => l.amountMinor ?? 0));
  return { currency: c, incomeMinor: inc.amountMinor, incomeUnknown: inc.unknown, lines, assignedMinor, unassignedMinor: inc.amountMinor === null ? null : inc.amountMinor - assignedMinor };
}
