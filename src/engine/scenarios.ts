import type { Currency } from '../domain/money';
import { buildPlan, type Plan, type PlanInput, type PlanLine } from './planning';

/**
 * What-if scenarios (ADR-0008). Pure: they rebuild the plan from a modified copy of the inputs and NEVER write.
 * Every result says what changes until the next income: free money, what stays covered, and debt when relevant.
 */
export interface ScenarioResult {
  currency: Currency;
  freeBeforeMinor: number | null;
  freeAfterMinor: number | null;
  deltaMinor: number | null;
  /** Payments inside the horizon that the money on hand would no longer cover, in date order. */
  uncovered: string[];
  until: string | null;
  estimated: boolean;
  debt?: { name: string; balanceBeforeMinor: number; balanceAfterMinor: number; monthlyInterestSavedMinor: number | null };
}

function compare(before: Plan, after: Plan): ScenarioResult {
  const free = (p: Plan) => p.freeMinor;
  return {
    currency: after.currency, freeBeforeMinor: free(before), freeAfterMinor: free(after),
    deltaMinor: free(before) !== null && free(after) !== null ? free(after)! - free(before)! : null,
    uncovered: uncoveredLines(after), until: after.until, estimated: after.status !== 'confirmed',
  };
}

/** Walk the planned outflows in order: the ones the balance cannot reach are "not covered". */
function uncoveredLines(p: Plan): string[] {
  if (!p.base) return [];
  let left = p.base.amountMinor;
  const out: string[] = [];
  const dated = p.lines.filter((l): l is PlanLine & { amountMinor: number } => l.amountMinor !== null && (l.kind === 'overdue' || l.kind === 'payment' || l.kind === 'debt'));
  for (const l of dated) { left -= l.amountMinor; if (left < 0) out.push(l.label); }
  return out;
}

/** "¿Qué pasa si mi ingreso se retrasa N días?" — the horizon stretches; more payments and days of basics fall in it. */
export function delayIncome(input: PlanInput, days: number): ScenarioResult | null {
  if (!Number.isInteger(days) || days < 1 || days > 60) return null;
  return compare(buildPlan(input), buildPlan({ ...input, incomeDelayDays: days }));
}

/** "¿Qué pasa si este recibo sube a S/ X?" — only that payment's expected amount changes (a copy, not the data). */
export function changeBill(input: PlanInput, obligationId: string, amountMinor: number): ScenarioResult | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !input.obligations.some((o) => o.id === obligationId)) return null;
  const obligations = input.obligations.map((o) => (o.id === obligationId ? { ...o, amountMinor, amountStatus: 'confirmed' as const } : o));
  return compare(buildPlan(input), buildPlan({ ...input, obligations }));
}

/**
 * "¿Qué pasa si pago S/ X a la tarjeta?" — money leaves now; the card's planned payment in the horizon (its
 * minimum, if registered) is covered by it; the rest lowers the debt. Paying the card is never a new expense.
 * Interest saved is shown only when the rate is known (never guessed).
 */
export function payDebt(input: PlanInput, debt: { name: string; balanceMinor: number; annualRateBp: number | null; obligationId: string | null }, amountMinor: number): ScenarioResult | null {
  if (!input.base || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  const pay = Math.min(amountMinor, debt.balanceMinor);
  const before = buildPlan(input);
  const settled = new Map(input.settledObligations);
  if (debt.obligationId) {
    const line = before.lines.find((l) => l.obligationId === debt.obligationId && l.amountMinor !== null && l.amountMinor <= pay);
    const occ = line ? input.obligations.find((o) => o.id === debt.obligationId) : null;
    // The payment covers that occurrence: settle it in the copy (the month key of its date).
    if (line && occ && line.date) settled.set(occ.id, new Set([...(settled.get(occ.id) ?? []), line.date.slice(0, 7)]));
  }
  const after = buildPlan({ ...input, base: { ...input.base, amountMinor: input.base.amountMinor - pay }, settledObligations: settled });
  return {
    ...compare(before, after),
    debt: { name: debt.name, balanceBeforeMinor: debt.balanceMinor, balanceAfterMinor: debt.balanceMinor - pay,
      monthlyInterestSavedMinor: debt.annualRateBp === null ? null : Math.round((pay * debt.annualRateBp) / 10000 / 12) },
  };
}

// ── Debt payoff: avalanche / snowball / hybrid, explainable, never a ranking with missing rates ─────────
export interface PayoffDebt { id: string; name: string; balanceMinor: number; annualRateBp: number | null; minimumMinor: number | null }
export interface PayoffPlan { strategy: 'avalanche' | 'snowball' | 'hybrid'; order: string[]; months: number | null; interestMinor: number | null; why: string }
export interface PayoffComparison { available: boolean; missingRate: string[]; plans: PayoffPlan[]; note: string | null }

const MAX_MONTHS = 360;

function simulate(debts: PayoffDebt[], order: string[], budgetMinor: number): { months: number | null; interestMinor: number } {
  const bal = new Map(debts.map((d) => [d.id, d.balanceMinor]));
  let interest = 0;
  for (let m = 1; m <= MAX_MONTHS; m++) {
    for (const d of debts) {
      const b = bal.get(d.id)!;
      if (b > 0) { const i = Math.round((b * d.annualRateBp!) / 10000 / 12); interest += i; bal.set(d.id, b + i); }
    }
    let left = budgetMinor;
    for (const d of debts) { // minimums first (when known)
      const b = bal.get(d.id)!;
      const p = Math.min(b, d.minimumMinor ?? 0, left);
      bal.set(d.id, b - p); left -= p;
    }
    for (const id of order) { // the rest goes to the target in order
      const b = bal.get(id)!;
      const p = Math.min(b, left);
      bal.set(id, b - p); left -= p;
    }
    if ([...bal.values()].every((b) => b <= 0)) return { months: m, interestMinor: interest };
  }
  return { months: null, interestMinor: interest };
}

/**
 * Compares strategies for a monthly budget. With any rate missing there is no ranking (interest would be
 * invented): only the snowball order is shown and the missing rates are named. Hybrid = clear the debts that
 * one month of budget can finish first (quick wins), then highest rate.
 */
export function comparePayoff(debts: readonly PayoffDebt[], monthlyBudgetMinor: number): PayoffComparison {
  const open = debts.filter((d) => d.balanceMinor > 0);
  const missingRate = open.filter((d) => d.annualRateBp === null).map((d) => d.name);
  const snowball = [...open].sort((a, b) => a.balanceMinor - b.balanceMinor || a.name.localeCompare(b.name));
  if (!open.length) return { available: false, missingRate, plans: [], note: 'No tienes deudas abiertas.' };
  if (missingRate.length || !Number.isSafeInteger(monthlyBudgetMinor) || monthlyBudgetMinor <= 0) {
    return { available: false, missingRate, note: missingRate.length ? `Falta la tasa de ${missingRate.join(', ')}.` : 'Indica cuánto puedes pagar al mes.',
      plans: [{ strategy: 'snowball', order: snowball.map((d) => d.name), months: null, interestMinor: null, why: 'De la más chica a la más grande.' }] };
  }
  const avalanche = [...open].sort((a, b) => b.annualRateBp! - a.annualRateBp! || a.balanceMinor - b.balanceMinor);
  const quick = snowball.filter((d) => d.balanceMinor <= monthlyBudgetMinor);
  const hybrid = [...quick, ...avalanche.filter((d) => !quick.includes(d))];
  const run = (strategy: PayoffPlan['strategy'], list: PayoffDebt[], why: string): PayoffPlan => {
    const r = simulate(open, list.map((d) => d.id), monthlyBudgetMinor);
    return { strategy, order: list.map((d) => d.name), months: r.months, interestMinor: r.months === null ? null : r.interestMinor, why };
  };
  const plans = [
    run('avalanche', avalanche, 'Primero la de mayor tasa: pagas menos intereses.'),
    run('snowball', snowball, 'Primero la más chica: ves avances antes.'),
    run('hybrid', hybrid, 'Primero las que cierras en un mes, luego la de mayor tasa.'),
  ];
  const never = plans.every((p) => p.months === null);
  return { available: true, missingRate: [], plans, note: never ? 'Con ese monto al mes la deuda no baja: los intereses son mayores.' : null };
}

// ── Extra debt payment the plan allows (respecting the person's stated preference) ──────────────────────
export interface ExtraPayment { amountMinor: number; target: string; usesCushion: boolean; until: string | null; interestSavedMinor: number | null }

/**
 * What could go to debt today without touching what is already reserved. By default only free money; with the
 * preference "quedarme en cero si pago deuda" the cushion may go too — shown as a trade-off, never applied.
 * Target: highest known rate; with any rate unknown, the person picks (no invented ranking): target is ''.
 */
export function extraDebtPayment(plan: Pick<Plan, 'freeMinor' | 'until' | 'lines' | 'status'>, debts: ReadonlyArray<{ name: string; balanceMinor: number; annualRateBp: number | null }>,
  allowZero: boolean): ExtraPayment | null {
  if (plan.freeMinor === null || plan.status === 'incomplete') return null;
  const open = debts.filter((d) => d.balanceMinor > 0);
  if (!open.length) return null;
  const cushion = allowZero ? plan.lines.filter((l) => l.kind === 'cushion').reduce((s, l) => s + (l.amountMinor ?? 0), 0) : 0;
  const available = Math.max(0, plan.freeMinor) + cushion;
  if (available < 5000) return null; // under S/ 50 is noise, not a suggestion
  const rated = open.every((d) => d.annualRateBp !== null);
  const target = rated ? [...open].sort((a, b) => b.annualRateBp! - a.annualRateBp! || a.balanceMinor - b.balanceMinor)[0]! : open.length === 1 ? open[0]! : null;
  const amount = Math.min(available, target?.balanceMinor ?? available);
  return { amountMinor: amount, target: target?.name ?? '', usesCushion: allowZero && amount > Math.max(0, plan.freeMinor), until: plan.until,
    interestSavedMinor: target?.annualRateBp != null ? Math.round((amount * target.annualRateBp) / 10000 / 12) : null };
}
