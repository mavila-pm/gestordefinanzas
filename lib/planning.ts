import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import { financialEffect } from '../src/domain/financial-effect';
import { buildPlan, detectVariations, suggestMatches, type ExpectedIncome, type Obligation, type Plan, type PlanInput } from '../src/engine/planning';
import { limaToday } from '../src/domain/dates';
import {
  essentialSpendByMonth, essentialsSuggestion, isSuppressed, observedAmountsForUnknown, suggestIncomeMatches, timeline,
  type Decision,
  type EssentialsSuggestion, type IncomeMatch, type ObservedAmount, type TimelineItem,
} from '../src/engine/observed';
import { loadDecisions } from './learning';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../src/infrastructure/supabase/transaction-row';

const limaDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(0, 10);
const STALE_DAYS = 7;

export interface PlanningData {
  today: string;
  obligations: Obligation[];
  obligationRows: Array<Obligation & { active: boolean; notes: string | null }>;
  incomes: ExpectedIncome[];
  settledObligations: Map<string, Set<string>>;
  settledIncomes: Map<string, Set<string>>;
  balances: Partial<Record<Currency, { amountMinor: number; asOf: string; stale: boolean }>>;
  settings: Partial<Record<Currency, { essentialsMonthlyMinor: number | null; essentialsEstimated: boolean; cushionMinor: number; allowZeroForDebt: boolean }>>;
  debts: Array<{ id: string; name: string; currency: Currency; balanceMinor: number; annualRateBp: number | null }>;
  recentIncome: { transactionId: string; amountMinor: number; currency: Currency; date: string; merchant: string | null } | null;
  suggestions: ReturnType<typeof suggestMatches>;
  variations: ReturnType<typeof detectVariations>;
  /** "Parece tu sueldo de octubre": a received deposit that looks like an expected income (never auto-linked). */
  incomeMatches: IncomeMatch[];
  /** A payment whose amount was unknown now has a real linked amount (suggest, never replace silently). */
  observedAmounts: ObservedAmount[];
  decisions: Decision[];
  transactionsById: Map<string, { amountMinor: number; occurredOn: string; merchant: string | null }>;
}

/** Everything the planner needs, read under the user's session (RLS). */
export async function loadPlanningData(supabase: SupabaseClient, now = new Date()): Promise<PlanningData> {
  const today = limaToday(now);
  const since = new Date(now.getTime() - 45 * 86_400_000).toISOString();
  const [fx, debts, inc, settle, bal, set, txs, decided] = await Promise.all([
    supabase.from('fixed_expenses').select('id,name,kind,currency,amount_minor,amount_status,frequency,anchor_month,due_day,due_day_max,target_day,notes,active,created_at,paused_until,ended_on'),
    supabase.from('debts').select('id,name,currency,balance_minor,annual_rate_bp,installment_minor,installments_total,installments_paid,due_day,active,created_at,last_payment_on'),
    supabase.from('expected_incomes').select('id,name,currency,amount_minor,amount_status,frequency,day_of_month,day_max,second_day,anchor_date,paused_until,ended_on').eq('active', true),
    supabase.from('plan_settlements').select('fixed_expense_id,expected_income_id,period,transaction_id,variance_ack,tx:transactions(amount_minor)').order('period', { ascending: false }).limit(500),
    supabase.from('balance_snapshots').select('currency,amount_minor,as_of').order('as_of', { ascending: false }).limit(20),
    supabase.from('planning_settings').select('currency,essentials_monthly_minor,essentials_status,cushion_minor,allow_zero_for_debt'),
    supabase.from('transactions').select(TRANSACTION_SELECT).eq('status', 'confirmed').gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(1000),
    loadDecisions(supabase),
  ]);

  const obligationRows = (fx.data ?? []).map((r) => ({
    id: r.id as string, source: 'obligation' as const, name: r.name as string, kind: r.kind, currency: r.currency as Currency,
    amountMinor: r.amount_minor === null ? null : Number(r.amount_minor), amountStatus: r.amount_status, frequency: r.frequency,
    anchorMonth: r.anchor_month as number | null, dueDay: r.due_day as number | null, dueDayMax: r.due_day_max as number | null,
    targetDay: r.target_day as number | null, since: limaDate(r.created_at as string), active: r.active as boolean, notes: r.notes as string | null,
    pausedUntil: r.paused_until as string | null, endedOn: r.ended_on as string | null,
  }));
  const debtRows = debts.data ?? [];
  const debtObligations: Obligation[] = debtRows
    .filter((d) => d.active && d.installment_minor && Number(d.balance_minor) > 0 && (d.installments_total === null || d.installments_paid < d.installments_total))
    .map((d) => ({
      id: d.id, source: 'debt', name: d.name, kind: 'loan', currency: d.currency, amountMinor: Math.min(Number(d.installment_minor), Number(d.balance_minor)),
      amountStatus: 'confirmed', frequency: 'monthly', anchorMonth: null, dueDay: d.due_day, dueDayMax: null, targetDay: null, since: limaDate(d.created_at),
    }));

  const settledObligations = new Map<string, Set<string>>();
  const settledIncomes = new Map<string, Set<string>>();
  const paid: Array<{ obligationId: string; period: string; actualMinor: number; acknowledged: boolean }> = [];
  const linked = new Set<string>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(v); };
  for (const s of settle.data ?? []) {
    if (s.transaction_id) linked.add(s.transaction_id);
    if (s.fixed_expense_id) {
      add(settledObligations, s.fixed_expense_id, s.period);
      const amount = (s.tx as unknown as { amount_minor: number } | null)?.amount_minor;
      if (amount != null) paid.push({ obligationId: s.fixed_expense_id, period: s.period, actualMinor: Number(amount), acknowledged: s.variance_ack });
    }
    if (s.expected_income_id) add(settledIncomes, s.expected_income_id, s.period);
  }
  // A debt payment registered in Próximos pagos settles that month's installment.
  for (const d of debtRows) if (d.last_payment_on) add(settledObligations, d.id, String(d.last_payment_on).slice(0, 7));

  const transactions = ((txs.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction);
  const balances: PlanningData['balances'] = {};
  for (const b of bal.data ?? []) {
    const cur = b.currency as Currency;
    if (balances[cur]) continue;
    const asOf = b.as_of as string;
    // Stale: old, or money moved in the account after it (credit card purchases don't move the account).
    const moved = transactions.some((t) => t.currency === cur && Date.parse(t.occurredAt) > Date.parse(asOf) && t.type !== 'credit_card_purchase'
      && ['income', 'expense', 'transfer_to_cash', 'expense_reduction'].includes(financialEffect(t.type)));
    balances[cur] = { amountMinor: Number(b.amount_minor), asOf, stale: moved || Date.parse(asOf) < now.getTime() - STALE_DAYS * 86_400_000 };
  }
  const settings: PlanningData['settings'] = {};
  for (const s of set.data ?? []) settings[s.currency as Currency] = { essentialsMonthlyMinor: s.essentials_monthly_minor === null ? null : Number(s.essentials_monthly_minor), essentialsEstimated: s.essentials_status === 'estimated', cushionMinor: Number(s.cushion_minor), allowZeroForDebt: s.allow_zero_for_debt === true };

  const incomes: ExpectedIncome[] = (inc.data ?? []).map((i) => ({
    id: i.id, name: i.name, currency: i.currency, amountMinor: i.amount_minor === null ? null : Number(i.amount_minor), amountStatus: i.amount_status,
    frequency: i.frequency, dayOfMonth: i.day_of_month, dayMax: i.day_max, secondDay: i.second_day, anchorDate: i.anchor_date,
    pausedUntil: i.paused_until, endedOn: i.ended_on,
  }));
  const incomeTx = transactions.filter((t) => t.type === 'income' && Date.parse(t.occurredAt) >= now.getTime() - 10 * 86_400_000);
  const top = incomeTx.sort((a, b) => b.amountMinor - a.amountMinor)[0];
  const outflows = transactions.filter((t) => t.direction === 'outflow' && financialEffect(t.type) !== 'internal_movement' || t.type === 'credit_card_payment')
    .map((t) => ({ id: t.id, occurredOn: limaDate(t.occurredAt), amountMinor: t.amountMinor, currency: t.currency, merchant: t.merchantRaw }));
  const obligations: Obligation[] = [...obligationRows.filter((o) => o.active), ...debtObligations];

  return {
    today, obligations, obligationRows, incomes, settledObligations, settledIncomes, balances, settings,
    debts: debtRows.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name, currency: d.currency, balanceMinor: Number(d.balance_minor), annualRateBp: d.annual_rate_bp })),
    recentIncome: top ? { transactionId: top.id, amountMinor: top.amountMinor, currency: top.currency, date: limaDate(top.occurredAt), merchant: top.merchantRaw } : null,
    suggestions: suggestMatches(obligationRows.filter((o) => o.active), outflows, settledObligations, linked),
    variations: detectVariations(obligationRows.filter((o) => o.active), paid),
    // "No es ese" / "Ahora no": the person's decisions hide a suggestion (never the data behind it).
    incomeMatches: suggestIncomeMatches(incomes, transactions.filter((t) => t.type === 'income')
      .map((t) => ({ id: t.id, occurredOn: limaDate(t.occurredAt), amountMinor: t.amountMinor, currency: t.currency, merchant: t.merchantRaw })), settledIncomes, linked)
      .filter((m) => !isSuppressed(decided, 'income_match', m.transactionId, null, today)),
    observedAmounts: observedAmountsForUnknown(obligationRows.filter((o) => o.active), paid)
      .filter((o) => !isSuppressed(decided, 'observed_amount', o.obligationId, o.observedMinor, today)),
    decisions: decided,
    transactionsById: new Map(transactions.map((t) => [t.id, { amountMinor: t.amountMinor, occurredOn: limaDate(t.occurredAt), merchant: t.merchantRaw }])),
  };
}

/** Plan per currency from the declared balance ("Dinero libre"), or from an income that just arrived. */
export function planFor(d: PlanningData, currency: Currency, base: 'balance' | { transactionId: string } = 'balance'): Plan {
  return buildPlan(planInputFor(d, currency, base));
}

/** The exact inputs of a plan (what-if scenarios rebuild from a modified copy; nothing is written). */
export function planInputFor(d: PlanningData, currency: Currency, base: 'balance' | { transactionId: string } = 'balance'): PlanInput {
  const s = d.settings[currency];
  let planBase: PlanInput['base'] = null;
  if (base === 'balance') {
    const b = d.balances[currency];
    planBase = b ? { kind: 'balance', amountMinor: b.amountMinor, asOf: b.asOf, stale: b.stale } : null;
  } else {
    const t = d.transactionsById.get(base.transactionId);
    planBase = t ? { kind: 'income', amountMinor: t.amountMinor, date: t.occurredOn } : null;
  }
  return ({
    currency, today: d.today, base: planBase, obligations: d.obligations, settledObligations: d.settledObligations,
    incomes: d.incomes, settledIncomes: d.settledIncomes, essentialsMonthlyMinor: s?.essentialsMonthlyMinor ?? null, essentialsEstimated: s?.essentialsEstimated ?? false, cushionMinor: s?.cushionMinor ?? 0,
  });
}

/** What comes, in date order: expected incomes and unpaid planned payments (all currencies, each kept apart). */
export function planTimeline(d: PlanningData, days = 35): TimelineItem[] {
  return timeline({ today: d.today, obligations: d.obligations, incomes: d.incomes, settledObligations: d.settledObligations, settledIncomes: d.settledIncomes }, days);
}

/**
 * Estimated day-to-day spending vs what the movements show (PEN). Reads the last ~3 complete months separately
 * (only the plan page needs it). Suggestion only: the estimate changes when the person accepts.
 */
export type EssentialRows = Array<Parameters<typeof essentialSpendByMonth>[0][number]>;

/** The last ~3 complete months of PEN movements, split-aware. Fetched in parallel with loadPlanningData. */
export async function loadEssentialRows(supabase: SupabaseClient, now = new Date()): Promise<EssentialRows> {
  const [y, m] = limaToday(now).slice(0, 7).split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 4, 1, 5)).toISOString(); // Lima midnight, three months back
  const { data } = await supabase.from('transactions').select(TRANSACTION_SELECT).eq('status', 'confirmed').eq('currency', 'PEN')
    .gte('occurred_at', start).order('occurred_at', { ascending: false }).limit(2000);
  return ((data ?? []) as unknown as TransactionRow[]).map(rowToTransaction).map((t) => ({
    occurredOn: limaDate(t.occurredAt), amountMinor: t.amountMinor, currency: t.currency, isExpense: financialEffect(t.type) === 'expense',
    category: t.category, allocations: t.allocations,
  }));
}

/** Estimated day-to-day spending vs what the movements show (PEN). Suggestion only; hidden if the person decided. */
export function essentialsFor(d: PlanningData, rows: EssentialRows): EssentialsSuggestion | null {
  const estimate = d.settings.PEN?.essentialsMonthlyMinor ?? null;
  if (estimate === null) return null;
  const s = essentialsSuggestion(estimate, essentialSpendByMonth(rows, 'PEN'), d.today.slice(0, 7));
  return s && !isSuppressed(d.decisions, 'essentials', 'PEN', s.observedMinor, d.today) ? s : null;
}

export async function loadEssentialsSuggestion(supabase: SupabaseClient, d: PlanningData): Promise<EssentialsSuggestion | null> {
  return essentialsFor(d, await loadEssentialRows(supabase));
}
