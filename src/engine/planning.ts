/**
 * Cash-flow planning (ADR-0005). Pure and deterministic: the database and the UI only feed and render it.
 * Horizon = TODAY -> NEXT EXPECTED INCOME (not "end of month"). Nothing here moves money or creates transactions:
 * planned payments are not expenses, expected incomes are not money, and every number shown can be explained
 * line by line. Missing data is never invented: it lowers the plan's status and is listed as "falta confirmar".
 * Currencies are never mixed: one plan per currency.
 */
import { formatMoney, type Currency } from '../domain/money';
import { addDays, daysBetween } from '../domain/dates';

export type AmountStatus = 'confirmed' | 'estimated' | 'unknown';
export type ObligationKind = 'rent' | 'car' | 'loan' | 'card' | 'internet' | 'phone' | 'insurance' | 'education' | 'services' | 'taxes' | 'subscription' | 'other';
export type Frequency = 'monthly' | 'bimonthly' | 'quarterly' | 'yearly';
const STEP: Record<Frequency, number> = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };

export interface Obligation {
  id: string;
  source: 'obligation' | 'debt';
  name: string;
  kind: ObligationKind;
  currency: Currency;
  amountMinor: number | null;
  amountStatus: AmountStatus;
  frequency: Frequency;
  anchorMonth: number | null;
  dueDay: number | null;
  dueDayMax: number | null;
  targetDay: number | null;
  /** Lima date it was created: occurrences before it are not the person's to cover here. */
  since: string;
  /** Paused: occurrences dated before this day are not planned (history untouched). */
  pausedUntil?: string | null;
  /** Ended: no occurrences after this day (past ones and their settlements stay). */
  endedOn?: string | null;
}

export interface ExpectedIncome {
  id: string;
  name: string;
  currency: Currency;
  amountMinor: number | null;
  amountStatus: AmountStatus;
  frequency: 'monthly' | 'semimonthly' | 'biweekly' | 'weekly';
  dayOfMonth: number | null;
  dayMax: number | null;
  secondDay: number | null;
  anchorDate: string | null;
  pausedUntil?: string | null;
  endedOn?: string | null;
}

export interface Occurrence {
  obligationId: string;
  source: Obligation['source'];
  name: string;
  kind: ObligationKind;
  currency: Currency;
  period: string;
  /** Exact due date, or the first day of the window; null when the date is unknown. */
  dueDate: string | null;
  /** Last day of an uncertain window ("9-10 aprox."). */
  dueDateMax: string | null;
  /** When the person wants to pay it (before the due date). */
  targetDate: string | null;
  dateStatus: 'exact' | 'window' | 'unknown';
  amountMinor: number | null;
  amountStatus: AmountStatus;
}

export interface IncomeOccurrence { incomeId: string; name: string; currency: Currency; period: string; date: string; dateMax: string | null; amountMinor: number | null; amountStatus: AmountStatus }

// ── Dates (Lima calendar days as YYYY-MM-DD strings; pure arithmetic in UTC) ──────────────────────────────
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthKey = (d: string) => d.slice(0, 7);
function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 7);
}
function dayIn(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, '0')}`;
}

/** Occurrences of an obligation for the months touching [from, to]. Future occurrences are computed, never stored. */
export function occurrencesBetween(o: Obligation, from: string, to: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (let month = monthKey(from); month <= monthKey(to); month = addMonths(month, 1)) {
    const m = Number(month.slice(5, 7));
    if (o.frequency !== 'monthly') {
      if (o.anchorMonth === null || ((m - o.anchorMonth) % STEP[o.frequency] + 12) % STEP[o.frequency] !== 0) continue;
    }
    const due = o.dueDay === null ? null : dayIn(month, o.dueDay);
    const dueMax = o.dueDay !== null && o.dueDayMax !== null ? dayIn(month, o.dueDayMax) : null;
    const target = o.targetDay !== null ? dayIn(month, o.targetDay) : null;
    out.push({
      obligationId: o.id, source: o.source, name: o.name, kind: o.kind, currency: o.currency, period: month,
      dueDate: due, dueDateMax: dueMax, targetDate: target && due && target <= (dueMax ?? due) ? target : null,
      dateStatus: due === null ? 'unknown' : dueMax ? 'window' : 'exact',
      amountMinor: o.amountStatus === 'unknown' ? null : o.amountMinor, amountStatus: o.amountStatus,
    });
  }
  return out.filter((x) => inLifecycle(x.dueDate ?? `${x.period}-01`, o));
}

/** Paused / ended recurrences (ADR-0010): a date is planned only inside the item's active life. */
function inLifecycle(date: string, r: { pausedUntil?: string | null; endedOn?: string | null }): boolean {
  if (r.pausedUntil && date < r.pausedUntil) return false;
  if (r.endedOn && date > r.endedOn) return false;
  return true;
}

/**
 * The earliest occurrence still open (unpaid, not skipped) from one month back — the one "Omitir" applies to.
 * Same look-back as the plan's overdue window; never before the item existed.
 */
export function openOccurrence(o: Obligation, today: string, settledPeriods: ReadonlySet<string>): Occurrence | null {
  const lookback = addDays(today, -31);
  return occurrencesBetween(o, lookback, addDays(today, 62))
    .find((x) => !settledPeriods.has(x.period) && x.period >= monthKey(o.since)
      && (x.dueDate === null || ((x.dueDateMax ?? x.dueDate) >= lookback && x.dueDate >= o.since))) ?? null;
}

/** The next occurrence not yet settled (paid), from `today`; used after a payment: "la próxima queda preparada". */
export function nextOccurrence(o: Obligation, today: string, settledPeriods: ReadonlySet<string>): Occurrence | null {
  const horizonMonths = STEP[o.frequency] + 1;
  return occurrencesBetween(o, dayIn(monthKey(today), 1), dayIn(addMonths(monthKey(today), horizonMonths), 1))
    .find((x) => !settledPeriods.has(x.period) && x.period >= monthKey(o.since)) ?? null;
}

/**
 * What really happened to one occurrence (ADR-0017), from its settlement rows. Skipped ≠ paid. A 'partial' row is a
 * real payment smaller than the plan: the occurrence is 'paid' only when a row closes it (the person said "pago
 * completo", or the server saw the real total reach the plan) or when the real amounts reach a known planned amount.
 */
export type OccurrenceState = 'paid' | 'skipped' | 'partial' | 'open';
export interface SettlementRow { obligationId: string; period: string; status: 'paid' | 'partial' | 'skipped'; amountMinor: number | null }
export function occurrenceState(rows: readonly SettlementRow[], obligationId: string, period: string, plannedMinor: number | null = null): OccurrenceState {
  const mine = rows.filter((r) => r.obligationId === obligationId && r.period === period);
  if (mine.some((r) => r.status === 'paid')) return 'paid';
  if (mine.some((r) => r.status === 'skipped')) return 'skipped';
  const partial = mine.filter((r) => r.status === 'partial');
  if (!partial.length) return 'open';
  const paid = partial.reduce((s, r) => s + (r.amountMinor ?? 0), 0);
  return plannedMinor !== null && paid >= plannedMinor ? 'paid' : 'partial';
}

/**
 * The status a new settlement is stored with (decided on the server from REAL amounts, never from a form amount):
 * "Pago completo" closes the occurrence whatever the amount (the person says it is done); "Fue un abono" stays
 * partial until the real abonos plus this movement reach a known planned amount, which then closes it.
 */
export function settlementStatus(mode: 'full' | 'partial', plannedMinor: number | null, priorAbonosMinor: number, txMinor: number): 'paid' | 'partial' {
  if (mode === 'full') return 'paid';
  return plannedMinor !== null && priorAbonosMinor + txMinor >= plannedMinor ? 'paid' : 'partial';
}

// ── Incomes ───────────────────────────────────────────────────────────────────────────────────────────────
export function incomeOccurrencesBetween(i: ExpectedIncome, from: string, to: string): IncomeOccurrence[] {
  const out: IncomeOccurrence[] = [];
  const base = { incomeId: i.id, name: i.name, currency: i.currency, amountMinor: i.amountStatus === 'unknown' ? null : i.amountMinor, amountStatus: i.amountStatus };
  if (i.frequency === 'monthly' || i.frequency === 'semimonthly') {
    for (let month = monthKey(from); month <= monthKey(to); month = addMonths(month, 1)) {
      if (i.dayOfMonth === null) break;
      const days = i.frequency === 'semimonthly' && i.secondDay !== null ? [i.dayOfMonth, i.secondDay].sort((a, b) => a - b) : [i.dayOfMonth];
      for (const [k, d] of days.entries()) {
        const date = dayIn(month, d);
        out.push({ ...base, period: days.length > 1 ? `${month}-${String(k + 1).padStart(2, '0')}` : month, date,
          dateMax: i.frequency === 'monthly' && i.dayMax !== null ? dayIn(month, i.dayMax) : null });
      }
    }
  } else if (i.anchorDate) {
    const step = i.frequency === 'weekly' ? 7 : 14;
    let d = i.anchorDate;
    while (d < from) d = addDays(d, step);
    while (d > from && addDays(d, -step) >= from) d = addDays(d, -step);
    for (; d <= to; d = addDays(d, step)) out.push({ ...base, period: d, date: d, dateMax: null });
  }
  return out.filter((x) => (x.dateMax ?? x.date) >= from && x.date <= to && inLifecycle(x.date, i));
}

/**
 * Next expected income across all incomes of a currency (several payers supported). An expected income is NEVER
 * money: it only closes the planning horizon. Received occurrences (settled periods) are skipped.
 */
export function nextIncome(incomes: readonly ExpectedIncome[], currency: Currency, after: string, settled: ReadonlyMap<string, ReadonlySet<string>>): IncomeOccurrence | null {
  const candidates = incomes.filter((i) => i.currency === currency)
    .flatMap((i) => incomeOccurrencesBetween(i, after, addDays(after, 62)).filter((o) => !settled.get(i.id)?.has(o.period) && o.date > after));
  return candidates.sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
}

// ── Safe-to-spend ("Dinero libre") ────────────────────────────────────────────────────────────────────────
/** 'reserve' = planned contribution (infrequent payment or an Apartado's target); 'fund' = money already set aside. */
export type LineKind = 'overdue' | 'payment' | 'essentials' | 'debt' | 'reserve' | 'fund' | 'cushion';
/**
 * amountMinor is what is still owed (planned − real abonos). When abonos exist, paidMinor is their real total and
 * plannedMinor the occurrence's planned amount (null when unknown), so the screen can say "Pagaste X de Y".
 */
export interface PlanLine {
  kind: LineKind; label: string; amountMinor: number | null; date: string | null; dateMax: string | null; note: string | null; obligationId?: string; period?: string;
  paidMinor?: number; plannedMinor?: number | null;
  /** The Apartado a 'fund' / 'reserve' line belongs to. */
  reserveId?: string;
}
export interface Missing { code: 'balance' | 'balance_stale' | 'next_income' | 'amount' | 'date' | 'essentials' | 'income_window'; text: string; obligationId?: string }
export type PlanStatus = 'confirmed' | 'partial' | 'incomplete';

export interface PlanInput {
  currency: Currency;
  today: string;
  /** What the plan distributes: the declared balance, or an income that just arrived. */
  /** bankMinor / cashMinor: the breakdown the person gave (display only; the engine uses amountMinor). */
  base: { kind: 'balance'; amountMinor: number; asOf: string; stale: boolean; bankMinor?: number | null; cashMinor?: number | null } | { kind: 'income'; amountMinor: number; date: string } | null;
  obligations: readonly Obligation[];
  /** obligationId -> periods closed: paid (linked to a real transaction) or skipped. */
  settledObligations: ReadonlyMap<string, ReadonlySet<string>>;
  /** obligationId -> period -> real total of the abonos of a still-open occurrence (ADR-0017). */
  partialPaid?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  incomes: readonly ExpectedIncome[];
  settledIncomes: ReadonlyMap<string, ReadonlySet<string>>;
  essentialsMonthlyMinor: number | null;
  cushionMinor: number;
  /** The basics amount is the person's estimate ("pongámosle S/500"): the plan stays "estimado". */
  essentialsEstimated?: boolean;
  /** What-if only: the next income arrives this many days later than expected (scenarios.ts). */
  incomeDelayDays?: number;
  /** Apartados (all currencies; the plan keeps only its own). Saved money is not free money (ADR-0017). */
  reserves?: readonly Reserve[];
  /** Overrides INFREQUENT_RESERVE_RULE (tests / what-if only). */
  infrequentRule?: InfrequentRule;
}

/**
 * An Apartado (named reserve) as the engine sees it. savedMinor = Σ in − Σ out of its REAL entries (SQL view
 * reserve_balances), never a typed total. Target and date are optional; without both nothing is planned for it.
 */
export interface Reserve { id: string; name: string; currency: Currency; savedMinor: number; targetMinor: number | null; targetDate: string | null }

/**
 * How the plan reserves for an infrequent payment (yearly SOAT, quarterly tax) due after the horizon.
 *   'proportional' (ADR-0005, accepted): amount × horizon days / the period length in days.
 *   'time_left'    (ADR-0017, PENDING PO APPROVAL): amount × horizon days / days left until it is due — the closer
 *                  the date, the larger the share (SOAT S/ 600 in 36 days, 15-day horizon: S/ 25 → S/ 250).
 * Single switch: change it only after the PO approves ADR-0017 §"Reserva por tiempo restante".
 */
export type InfrequentRule = 'proportional' | 'time_left';
export const INFREQUENT_RESERVE_RULE: InfrequentRule = 'proportional';

export interface Plan {
  currency: Currency;
  status: PlanStatus;
  base: PlanInput['base'];
  from: string;
  nextIncome: IncomeOccurrence | null;
  /** Last day covered by this plan (the day before the next income; window-aware). */
  until: string | null;
  lines: PlanLine[];
  reservedMinor: number;
  freeMinor: number | null;
  missing: Missing[];
}

/** Planned amounts are rounded to whole soles/dollars (never used for real movements). */
const roundUnit = (minor: number) => Math.round(minor / 100) * 100;
const ORDER: Record<LineKind, number> = { overdue: 0, payment: 1, essentials: 2, debt: 3, reserve: 4, fund: 5, cushion: 6 };
const fmtDay = (d: string) => `${Number(d.slice(8, 10))}/${d.slice(5, 7)}`;

export function buildPlan(input: PlanInput): Plan {
  const { currency, today } = input;
  const from = input.base?.kind === 'income' ? input.base.date : today;
  const missing: Missing[] = [];
  if (!input.base) missing.push({ code: 'balance', text: 'Indica cuánto tienes hoy en tu cuenta.' });
  else if (input.base.kind === 'balance' && input.base.stale) missing.push({ code: 'balance_stale', text: `Tu saldo es del ${fmtDay(input.base.asOf.slice(0, 10))}. Actualízalo para afinar el cálculo.` });

  const expected = nextIncome(input.incomes, currency, from, input.settledIncomes);
  const delay = input.incomeDelayDays ?? 0;
  const next = expected && delay > 0 ? { ...expected, date: addDays(expected.date, delay), dateMax: expected.dateMax ? addDays(expected.dateMax, delay) : null } : expected;
  if (!next) missing.push({ code: 'next_income', text: 'Falta tu próximo ingreso: sin él no sabemos hasta cuándo alcanzar.' });
  // Uncertain income date: plan conservatively until the LAST possible day, and say so.
  const incomeDay = next ? (next.dateMax ?? next.date) : null;
  if (next?.dateMax) missing.push({ code: 'income_window', text: `Tu ingreso llega entre el ${fmtDay(next.date)} y el ${fmtDay(next.dateMax)}: contamos hasta el ${fmtDay(next.dateMax)}.` });
  const until = incomeDay ? addDays(incomeDay, -1) : null;

  const lines: PlanLine[] = [];
  // Overdue look-back: one month. Older unpaid items are not guessed as debts here (they surface as review, not plan).
  const lookback = addDays(from, -31);
  for (const o of input.obligations.filter((x) => x.currency === currency)) {
    const paid = input.settledObligations.get(o.id) ?? new Set<string>();
    const occ = occurrencesBetween(o, lookback, until ?? from).filter((x) => !paid.has(x.period) && x.period >= monthKey(o.since));
    let unknownDateCounted = false;
    for (const x of occ) {
      const payOn = x.targetDate ?? x.dueDate; // plan by the day the person wants to pay
      // Abonos of this occurrence (real movements): only what remains is reserved; covered → nothing left to plan.
      const abono = input.partialPaid?.get(o.id)?.get(x.period) ?? 0;
      if (remainingMinor(x.amountMinor, abono) === 0) continue;
      if (x.dateStatus === 'unknown') {
        // A date we don't know: reserve it once (the earliest unpaid period) and ask for the date.
        if (unknownDateCounted || !until) continue;
        unknownDateCounted = true;
        missing.push({ code: 'date', text: `Falta la fecha de ${o.name}.`, obligationId: o.id });
        lines.push(line(x, o.source === 'debt' ? 'debt' : 'payment', null, abono));
        continue;
      }
      const lastDay = x.dueDateMax ?? x.dueDate!;
      if (lastDay < lookback || (lastDay < from && x.dueDate! < o.since)) continue;
      if (lastDay < from) { lines.push(line(x, 'overdue', abono > 0 ? 'Ya venció y falta completar el pago' : 'Ya venció y no vemos el pago', abono)); continue; }
      if (!until || payOn! > until) continue; // after the next income: that income covers it
      lines.push(line(x, o.source === 'debt' ? 'debt' : 'payment', x.dateStatus === 'window' ? `vence ${Number(x.dueDate!.slice(8))}–${Number(x.dueDateMax!.slice(8))} aprox.` : null, abono));
      if (x.dateStatus === 'window') missing.push({ code: 'date', text: `Confirma si ${o.name} vence el ${Number(x.dueDate!.slice(8))} o el ${Number(x.dueDateMax!.slice(8))}.`, obligationId: o.id });
    }
    // Infrequent obligations due after the horizon: plan a reserve (planned, not separated money). Rule: one switch.
    if (until && o.frequency !== 'monthly' && o.amountMinor !== null && o.amountStatus !== 'unknown') {
      const due = nextOccurrence(o, addDays(until, 1), paid);
      if (due?.dueDate && due.dueDate > until) {
        const months = STEP[o.frequency];
        // Rounded to whole units: a plan, not an invoice.
        const share = (input.infrequentRule ?? INFREQUENT_RESERVE_RULE) === 'time_left'
          ? timeShare(o.amountMinor, due.targetDate ?? due.dueDate, from, until)
          : roundUnit((o.amountMinor * (daysBetween(from, until) + 1)) / (months * 30.4375));
        if (share > 0) lines.push({ kind: 'reserve', label: `Para ${o.name}`, amountMinor: share, date: null, dateMax: null, note: `Vence en ${due.period}; separa de a pocos.`, obligationId: o.id });
      }
    }
  }
  // Apartados of this currency only (PEN ≠ USD): what is saved is set aside (real money, never rounded); a dated
  // target adds this horizon's planned contribution. No target or no date: nothing is planned (never invented).
  for (const r of (input.reserves ?? []).filter((x) => x.currency === currency)) {
    if (r.savedMinor > 0) lines.push({ kind: 'fund', label: `Apartado: ${r.name}`, amountMinor: r.savedMinor, date: null, dateMax: null, note: 'Ya separado: no es dinero libre', reserveId: r.id });
    const c = until ? reserveContribution(r, from, until) : null;
    if (c) lines.push({ kind: 'reserve', label: `Para ${r.name}`, amountMinor: c, date: null, dateMax: null,
      note: `Meta ${formatMoney({ amountMinor: r.targetMinor!, currency })} al ${fmtDay(r.targetDate!)}`, reserveId: r.id });
  }
  for (const l of lines) if (l.amountMinor === null && l.obligationId) {
    const already = l.paidMinor ? `: ya pagaste ${formatMoney({ amountMinor: l.paidMinor, currency })}` : '';
    if (!missing.some((m) => m.code === 'amount' && m.obligationId === l.obligationId)) missing.push({ code: 'amount', text: `Falta el monto de ${l.label}${already}.`, obligationId: l.obligationId });
  }

  if (until) {
    const days = daysBetween(from, until) + 1;
    if (input.essentialsMonthlyMinor === null) missing.push({ code: 'essentials', text: 'Indica cuánto necesitas al mes para lo básico (comida, transporte).' });
    else if (input.essentialsMonthlyMinor > 0) lines.push({ kind: 'essentials', label: 'Gastos básicos', amountMinor: roundUnit((input.essentialsMonthlyMinor * days) / 30), date: null, dateMax: null, note: `${days} días de lo que ${input.essentialsEstimated ? 'estimaste' : 'indicaste'} al mes` });
  }
  if (input.cushionMinor > 0) lines.push({ kind: 'cushion', label: 'Colchón', amountMinor: input.cushionMinor, date: null, dateMax: null, note: 'Lo que prefieres no tocar' });

  lines.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.date ?? '9').localeCompare(b.date ?? '9'));
  const reservedMinor = lines.reduce((s, l) => s + (l.amountMinor ?? 0), 0);
  const freeMinor = input.base && until ? input.base.amountMinor - reservedMinor : null;
  const blocking = missing.some((m) => m.code === 'balance' || m.code === 'next_income');
  const status: PlanStatus = blocking ? 'incomplete' : missing.length || (input.essentialsEstimated && until) ? 'partial' : 'confirmed';
  return { currency, status, base: input.base, from, nextIncome: next, until, lines, reservedMinor, freeMinor, missing };

  function line(x: Occurrence, kind: LineKind, note: string | null, abono: number): PlanLine {
    return {
      kind, label: x.name, amountMinor: remainingMinor(x.amountMinor, abono), date: x.targetDate ?? x.dueDate, dateMax: x.targetDate ? null : x.dueDateMax, note,
      obligationId: x.obligationId, period: x.period, ...(abono > 0 ? { paidMinor: abono, plannedMinor: x.amountMinor } : {}),
    };
  }
}

/**
 * This horizon's share of a planned amount due on `date` (ADR-0017): need × horizon days / days left until the date,
 * rounded to whole units (a plan), never above the need. Due inside the horizon → all of it now.
 */
function timeShare(needMinor: number, date: string, from: string, until: string): number {
  if (!Number.isSafeInteger(needMinor) || needMinor <= 0) return 0;
  if (date <= until) return needMinor;
  const share = roundUnit((needMinor * (daysBetween(from, until) + 1)) / daysBetween(from, date));
  return Math.min(needMinor, share);
}

/** Planned contribution of an Apartado in [from, until]: null without a target and a date; 0 once reached. */
export function reserveContribution(r: Pick<Reserve, 'savedMinor' | 'targetMinor' | 'targetDate'>, from: string, until: string): number | null {
  if (r.targetMinor === null || r.targetDate === null) return null;
  return timeShare(Math.max(0, r.targetMinor - Math.max(0, r.savedMinor)), r.targetDate, from, until);
}

/**
 * Progress of an Apartado (engine numbers; Vels and the screen only render them). Without a target there is no
 * ratio nor remaining (unknown ≠ 0). Suggested monthly = remaining / months left, whole units (a plan); the last
 * month asks for exactly what remains, so rounding never leaves the target short.
 */
export interface ReserveProgress {
  savedMinor: number; targetMinor: number | null; remainingMinor: number | null; ratio: number | null; reached: boolean;
  monthsLeft: number | null; monthlyMinor: number | null; late: boolean;
}
export function reserveProgress(r: Pick<Reserve, 'savedMinor' | 'targetMinor' | 'targetDate'>, today: string): ReserveProgress {
  const saved = Math.max(0, r.savedMinor);
  const target = r.targetMinor;
  const remaining = target === null ? null : Math.max(0, target - saved);
  const monthsLeft = target !== null && r.targetDate !== null ? Math.max(1, Math.ceil(daysBetween(today, r.targetDate) / 30.4375)) : null;
  const raw = remaining !== null && monthsLeft !== null ? roundUnit(remaining / monthsLeft) : null;
  return {
    savedMinor: saved, targetMinor: target, remainingMinor: remaining, ratio: target === null ? null : Math.min(1, saved / target),
    reached: remaining === 0, monthsLeft, late: r.targetDate !== null && r.targetDate < today && remaining !== 0,
    monthlyMinor: raw === null ? null : monthsLeft === 1 ? remaining : Math.min(remaining!, raw > 0 ? raw : remaining!),
  };
}

/**
 * What is still owed on one occurrence (ADR-0017): planned − real abonos, never below 0. Unknown planned stays
 * unknown (never 0): a real abono does not tell us the price.
 */
export function remainingMinor(plannedMinor: number | null, paidMinor: number): number | null {
  return plannedMinor === null ? null : Math.max(0, plannedMinor - paidMinor);
}

/**
 * Abonos per still-open occurrence: Σ of the real movements of its 'partial' rows. A movement counts only while it
 * is confirmed and in the payment's own currency (PEN ≠ USD); occurrences already closed are left out (the closing
 * row ends them), so the plan never subtracts an abono twice.
 */
export function abonosByOccurrence(
  rows: ReadonlyArray<{ obligationId: string; period: string; status: 'paid' | 'partial' | 'skipped'; amountMinor: number | null; currency: Currency | null; txConfirmed: boolean }>,
  currencyOf: ReadonlyMap<string, Currency>,
): Map<string, Map<string, number>> {
  const closed = new Set(rows.filter((r) => r.status !== 'partial').map((r) => `${r.obligationId}|${r.period}`));
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.status !== 'partial' || closed.has(`${r.obligationId}|${r.period}`) || r.amountMinor === null || !r.txConfirmed) continue;
    if (!currencyOf.has(r.obligationId) || r.currency !== currencyOf.get(r.obligationId)) continue;
    const m = out.get(r.obligationId) ?? out.set(r.obligationId, new Map()).get(r.obligationId)!;
    m.set(r.period, (m.get(r.period) ?? 0) + r.amountMinor);
  }
  return out;
}

/**
 * Real totals of CLOSED paid occurrences (a 'paid' row; rows without a status are paid): Σ of every real movement
 * linked to it, abonos included. Occurrences with only abonos are left out: they are not finished, so their amount
 * says nothing about the price (no "bajó S/ 1,000" for a partial payment).
 */
export interface PaidFact { obligationId: string; period: string; actualMinor: number; acknowledged?: boolean; status?: 'paid' | 'partial' }
export function closedPaidTotals(paid: readonly PaidFact[]): Array<{ obligationId: string; period: string; actualMinor: number; acknowledged: boolean }> {
  const groups = new Map<string, { obligationId: string; period: string; actualMinor: number; acknowledged: boolean; closed: boolean }>();
  for (const p of paid) {
    const key = `${p.obligationId}|${p.period}`;
    const g = groups.get(key) ?? { obligationId: p.obligationId, period: p.period, actualMinor: 0, acknowledged: false, closed: false };
    g.actualMinor += p.actualMinor;
    g.acknowledged ||= p.acknowledged === true;
    g.closed ||= (p.status ?? 'paid') === 'paid';
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.closed).map(({ closed: _c, ...g }) => g);
}

// ── What-if: "¿Puedo gastar S/500?" (pure: never writes anything) ─────────────────────────────────────────
export interface Simulation { beforeMinor: number; afterMinor: number; covered: boolean; shortfallMinor: number; estimated: boolean }
export function simulatePurchase(plan: Pick<Plan, 'freeMinor' | 'status'>, amountMinor: number): Simulation | null {
  if (plan.freeMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  const after = plan.freeMinor - amountMinor;
  return { beforeMinor: plan.freeMinor, afterMinor: after, covered: after >= 0, shortfallMinor: after < 0 ? -after : 0, estimated: plan.status !== 'confirmed' };
}

// ── Recurring amount changes ("Internet subió S/31") ─────────────────────────────────────────────────────
export interface Variation { obligationId: string; name: string; currency: Currency; expectedMinor: number; actualMinor: number; deltaMinor: number; period: string }
/** Compares the plan with the real total of the last CLOSED paid occurrence (abonos summed; open ones ignored). */
export function detectVariations(obligations: readonly Obligation[], paid: readonly PaidFact[]): Variation[] {
  const out: Variation[] = [];
  const closed = closedPaidTotals(paid);
  for (const o of obligations) {
    if (o.amountMinor === null || o.amountStatus === 'unknown') continue;
    const last = closed.filter((p) => p.obligationId === o.id).sort((a, b) => b.period.localeCompare(a.period))[0];
    if (!last || last.acknowledged || last.actualMinor === o.amountMinor) continue;
    out.push({ obligationId: o.id, name: o.name, currency: o.currency, expectedMinor: o.amountMinor, actualMinor: last.actualMinor, deltaMinor: last.actualMinor - o.amountMinor, period: last.period });
  }
  return out;
}

// ── "Parece la cuota del carro": suggestions only, never auto-linked ─────────────────────────────────────
export interface PaymentCandidate { id: string; occurredOn: string; amountMinor: number; currency: Currency; merchant: string | null }
/**
 * amountMinor: the movement; remainingMinor: what the occurrence still owes (null = unknown price); partial: the
 * movement is smaller than what remains, so the person chooses "Pago completo" or "Fue un abono" (never decided here).
 */
export interface MatchSuggestion {
  obligationId: string; name: string; period: string; transactionId: string; confidence: 'high' | 'medium';
  amountMinor?: number; remainingMinor?: number | null; partial?: boolean;
}
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

export function suggestMatches(
  obligations: readonly Obligation[], txs: readonly PaymentCandidate[], settled: ReadonlyMap<string, ReadonlySet<string>>, linkedTx: ReadonlySet<string>,
  partialPaid?: ReadonlyMap<string, ReadonlyMap<string, number>>,
): MatchSuggestion[] {
  const out: MatchSuggestion[] = [];
  const used = new Set(linkedTx);
  const near = (amount: number, target: number, status: AmountStatus) => Math.abs(amount - target) <= Math.max(100, Math.round(target * (status === 'confirmed' ? 0.02 : 0.25)));
  for (const o of obligations) {
    if (o.source !== 'obligation') continue;
    for (const t of txs) {
      if (used.has(t.id) || t.currency !== o.currency) continue;
      const period = monthKey(t.occurredOn);
      if (settled.get(o.id)?.has(period)) continue;
      const [x] = occurrencesBetween(o, dayIn(period, 1), dayIn(period, 28)).filter((y) => y.period === period);
      if (!x) continue;
      const abono = partialPaid?.get(o.id)?.get(period) ?? 0;
      const remaining = remainingMinor(o.amountMinor, abono);
      if (remaining === 0) continue; // already covered by real abonos
      const nameHit = !!t.merchant && norm(o.name).split(/\s+/).some((w) => w.length >= 4 && norm(t.merchant!).includes(w));
      // Against the planned amount, or against what remains after abonos ("ya pagué 500, hoy pago los 1,000").
      const amountHit = o.amountMinor !== null && (near(t.amountMinor, o.amountMinor, o.amountStatus) || (abono > 0 && near(t.amountMinor, remaining!, o.amountStatus)));
      // Same name, a smaller amount than what remains: maybe an abono (the person says so; never assumed).
      const abonoHit = nameHit && remaining !== null && t.amountMinor < remaining;
      const dateHit = x.dueDate === null || Math.abs(daysBetween(t.occurredOn, x.dueDateMax ?? x.dueDate)) <= 10;
      if (!dateHit || !(amountHit || nameHit)) continue;
      if (!amountHit && !abonoHit && o.amountMinor !== null) continue; // a name alone with a larger amount: the variation flow handles it after linking
      out.push({ obligationId: o.id, name: o.name, period, transactionId: t.id, confidence: amountHit && nameHit ? 'high' : 'medium',
        amountMinor: t.amountMinor, remainingMinor: remaining, partial: remaining !== null && t.amountMinor < remaining });
      used.add(t.id);
      break;
    }
  }
  return out;
}

// ── Debt strategies: shown side by side, never "the best" ─────────────────────────────────────────────────
export interface DebtInfo { id: string; name: string; currency: Currency; balanceMinor: number; annualRateBp: number | null }
export function compareDebtStrategies(debts: readonly DebtInfo[]): {
  avalanche: { available: boolean; order: string[]; missingRate: string[] };
  snowball: { order: string[] };
} {
  const open = debts.filter((d) => d.balanceMinor > 0);
  const missingRate = open.filter((d) => d.annualRateBp === null).map((d) => d.name);
  return {
    avalanche: {
      available: open.length > 0 && missingRate.length === 0,
      order: missingRate.length ? [] : [...open].sort((a, b) => b.annualRateBp! - a.annualRateBp! || a.balanceMinor - b.balanceMinor).map((d) => d.name),
      missingRate,
    },
    snowball: { order: [...open].sort((a, b) => a.balanceMinor - b.balanceMinor || a.name.localeCompare(b.name)).map((d) => d.name) },
  };
}

// ── Reminders (intent only; delivery adapters are future work) ───────────────────────────────────────────
export interface ReminderIntent { obligationId: string; name: string; on: string; kind: 'main' | 'second' }
export function reminderIntents(plan: Pick<Plan, 'lines'>, today: string): ReminderIntent[] {
  const out: ReminderIntent[] = [];
  for (const l of plan.lines) {
    if (!l.obligationId || !l.date || (l.kind !== 'payment' && l.kind !== 'debt' && l.kind !== 'overdue')) continue;
    out.push({ obligationId: l.obligationId, name: l.label, on: addDays(l.date, -2) < today ? today : addDays(l.date, -2), kind: 'main' });
    // Second notice only if still pending right before it is due.
    if (daysBetween(today, l.dateMax ?? l.date) <= 1) out.push({ obligationId: l.obligationId, name: l.label, on: today, kind: 'second' });
  }
  return out;
}

// ── Breakdown for the dashboard bar (pure) ──────────────────────────────────────────────────────────────
/** Pagos (dated payments/debts/overdue) vs reservado (basics, reserves, cushion); unknown amounts counted apart. */
export interface PlanBreakdown { committedMinor: number; setAsideMinor: number; freeMinor: number; unknownCount: number }
export function planBreakdown(p: Pick<Plan, 'lines' | 'freeMinor'>): PlanBreakdown | null {
  if (p.freeMinor === null) return null;
  let committedMinor = 0, setAsideMinor = 0, unknownCount = 0;
  for (const l of p.lines) {
    if (l.amountMinor === null) { unknownCount++; continue; }
    if (l.kind === 'payment' || l.kind === 'debt' || l.kind === 'overdue') committedMinor += l.amountMinor;
    else setAsideMinor += l.amountMinor;
  }
  return { committedMinor, setAsideMinor, freeMinor: p.freeMinor, unknownCount };
}
