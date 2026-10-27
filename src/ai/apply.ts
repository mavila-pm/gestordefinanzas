import { mergePatches } from './draft';
import { matchProvider } from '../domain/subscriptions';
import { formatMoney } from '../domain/money';
import { fold } from './text';
import { emptyDraft, type Draft, type Patch } from './types';

/**
 * Draft → domain rows (§67): the onboarding feeds the same tables the planner reads (expected_incomes,
 * fixed_expenses, debts, accounts/cards, balance_snapshots, planning_settings). Pure: the server action writes
 * these rows under the user's session (RLS). Nothing is invented: unknown amounts stay null with status
 * 'unknown'; a debt whose balance is unknown is not created (it stays pending in the draft, and its payment day,
 * if known, becomes a card payment with an unknown amount so the plan asks for it).
 */
const KNOWN_INSTITUTIONS = new Set(['BCP', 'BBVA', 'INTERBANK']);

export interface DomainWrites {
  incomes: Array<Record<string, unknown>>;
  obligations: Array<Record<string, unknown>>;
  debts: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  cards: Array<Record<string, unknown>>;
  balance: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  /** Monthly savings goal (planning_settings.savings_goal_minor), only when the person gave an amount. */
  savingsGoal: Record<string, unknown> | null;
  /** What stays "Por confirmar" in the draft (not writable yet). */
  deferred: string[];
}

export function domainWrites(d: Draft, userId: string): DomainWrites {
  const w: DomainWrites = { incomes: [], obligations: [], debts: [], accounts: [], cards: [], balance: null, settings: null, savingsGoal: null, deferred: [] };
  for (const i of d.incomes) {
    // Nothing declared (no amount, no day): there is nothing to save yet.
    if (i.amountMinor === null && i.day === null) { w.deferred.push(`${i.name}: falta el monto y el día`); continue; }
    // One-off or irregular: never planned as a recurring income (it would invent future money).
    if (i.frequency === 'occasional') { w.deferred.push(`${i.name}: ingreso ocasional, no se proyecta`); continue; }
    // What was declared is saved; what is missing stays "por confirmar" as a null day, which the planner never
    // projects: an unknown day, an extra income whose frequency was not said, or a quincena without its second day.
    const unsure = i.frequency === null && (i !== d.incomes[0] || d.work === 'independent');
    const semi = i.frequency === 'semimonthly' && i.secondDay !== null && i.day !== null;
    const day = unsure || (i.frequency === 'semimonthly' && !semi) ? null : i.day;
    if (day === null) w.deferred.push(`${i.name}: ${unsure ? 'frecuencia por confirmar' : i.frequency === 'semimonthly' && i.day !== null ? 'falta el segundo día de pago' : 'falta el día'}`);
    w.incomes.push({
      user_id: userId, name: i.name.slice(0, 60), currency: i.currency, amount_minor: i.amountMinor, amount_status: i.amountMinor === null ? 'unknown' : i.amountStatus,
      frequency: i.frequency === 'semimonthly' && (semi || day === null) ? 'semimonthly' : 'monthly', day_of_month: day, day_max: !semi && day !== null && i.dayMax && i.dayMax > day && i.dayMax - day <= 7 ? i.dayMax : null,
      second_day: semi ? i.secondDay : null,
    });
  }
  for (const o of d.obligations) {
    w.obligations.push({
      user_id: userId, name: o.name.slice(0, 60), kind: o.kind, currency: o.currency, amount_minor: o.amountMinor, amount_status: o.amountMinor === null ? 'unknown' : o.amountStatus,
      // A subscription keeps its catalogue service (logo in Mis suscripciones); unknown services stay custom.
      ...(o.kind === 'subscription' ? { provider: matchProvider(o.name)?.slug ?? null } : {}),
      frequency: 'monthly', due_day: o.day, due_day_max: o.day !== null && o.dayMax && o.dayMax > o.day && o.dayMax - o.day <= 7 ? o.dayMax : null,
    });
  }
  for (const x of d.debts) {
    if (x.balanceMinor !== null) {
      // Loans keep what the person said: amount lent, installment and installments (debts columns). The balance is
      // the one they gave, never principal − installments. The installment makes the engine plan the monthly payment.
      const total = x.installmentsTotal ?? null;
      const paid = x.installmentsPaid ?? (total !== null && x.installmentsLeft != null ? total - x.installmentsLeft : null);
      w.debts.push({
        user_id: userId, name: x.name.slice(0, 60), lender: (x.lender ?? x.institution)?.slice(0, 60) ?? null, currency: x.currency,
        principal_minor: x.principalMinor ?? Math.max(x.balanceMinor, 1), balance_minor: x.balanceMinor, due_day: x.dueDay,
        // A loan's installment, or what is paid back to a person each month: the engine plans it while a balance remains.
        ...((x.kind === 'loan' || x.kind === 'personal') && x.installmentMinor ? { installment_minor: x.installmentMinor } : {}),
        ...(x.kind === 'loan' && total && total <= 600 ? { installments_total: total } : {}),
        ...(x.kind === 'loan' && paid !== null && paid >= 0 && (total === null || paid <= total) ? { installments_paid: paid } : {}),
      });
    } else {
      w.deferred.push(`${x.name}: falta el saldo`);
      // The balance is unknown but the monthly installment is known ("pago 250 cada 8"): that payment is still planned
      // (a planned outflow), the debt itself waits for its balance — nothing is invented for it.
      if (x.kind === 'loan' && x.installmentMinor) w.obligations.push({ user_id: userId, name: x.name.slice(0, 60), kind: 'loan', currency: x.currency, amount_minor: x.installmentMinor,
        amount_status: 'confirmed', frequency: 'monthly', due_day: x.dueDay, due_day_max: null });
    }
    // The card's monthly payment is an obligation (card payment is never an expense; it is a planned outflow).
    if (x.kind === 'card' && (x.minimumMinor !== null || x.usualPaymentMinor != null || x.dueDay !== null) && !d.obligations.some((o) => o.kind === 'card')) {
      w.obligations.push({
        // What the person usually pays is the planned payment; the minimum is kept apart (never one for the other).
        user_id: userId, name: x.name.slice(0, 60), kind: 'card', currency: x.currency, amount_minor: x.usualPaymentMinor ?? x.minimumMinor,
        amount_status: (x.usualPaymentMinor ?? x.minimumMinor) == null ? 'unknown' : 'estimated', frequency: 'monthly', due_day: x.dueDay, due_day_max: null,
        ...(x.minimumMinor != null ? { notes: `Pago mínimo ${formatMoney({ amountMinor: x.minimumMinor, currency: x.currency })}` } : {}),
      });
    }
  }
  for (const a of d.accounts) {
    const institution = KNOWN_INSTITUTIONS.has(a.institution) ? a.institution : null;
    if (a.kind === 'card') {
      // The cut-off day the person gave for that card (same bank and last 4), never guessed.
      const cut = d.debts.find((x) => x.kind === 'card' && x.last4 === a.last4 && (!x.institution || x.institution === a.institution))?.cutDay ?? null;
      if (a.last4) w.cards.push({ user_id: userId, institution_code: institution, alias: `Tarjeta ${a.institution === 'OTRO' ? '' : a.institution}`.trim().slice(0, 60), kind: 'credit', currency: 'PEN', last4: a.last4, ...(cut ? { statement_day: cut } : {}) });
      continue;
    }
    w.accounts.push({ user_id: userId, institution_code: institution, alias: (institution ?? a.institution).slice(0, 60), currency: 'PEN' });
  }
  // Money today keeps the breakdown that was said (cuentas / efectivo); a part not said is not written (unknown ≠ 0).
  if (d.balance?.amountMinor != null) w.balance = { user_id: userId, currency: d.balance.currency, amount_minor: d.balance.amountMinor,
    ...(d.balance.bankMinor != null ? { bank_minor: d.balance.bankMinor } : {}), ...(d.balance.cashMinor != null ? { cash_minor: d.balance.cashMinor } : {}) };
  const known = d.variable.filter((v) => v.amountMinor !== null && v.currency === 'PEN');
  if (known.length) w.settings = { user_id: userId, currency: 'PEN', essentials_status: known.some((v) => v.amountStatus !== 'confirmed') ? 'estimated' : 'confirmed', essentials_monthly_minor: known.reduce((s, v) => s + v.amountMinor!, 0) };
  for (const v of d.variable) if (v.amountMinor === null) w.deferred.push(`${v.name}: falta el monto`);
  if (d.savings?.amountMinor != null && d.savings.amountMinor > 0) w.savingsGoal = { user_id: userId, currency: d.savings.currency, savings_goal_minor: d.savings.amountMinor };
  return w;
}

/**
 * Camera read in "Preguntar" after onboarding (§70): confirmed vision patches → writes against what already exists.
 * The same payment/debt/card is UPDATED (never duplicated); only fields the document shows change; unknown stays
 * unknown. Patches come back from a stored row, so they are re-validated here as untrusted input.
 */
export interface Existing {
  obligations: Array<{ id: string; name: string; kind: string; currency: string }>;
  debts: Array<{ id: string; name: string; currency: string }>;
  cardLast4: string[];
}
export interface PlannedWrites {
  inserts: Array<{ table: 'fixed_expenses' | 'debts' | 'cards' | 'balance_snapshots'; row: Record<string, unknown> }>;
  updates: Array<{ table: 'fixed_expenses' | 'debts'; id: string; patch: Record<string, unknown> }>;
}

const okMinor = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n < 1e12);
const okDay = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 31);
const okCur = (c: unknown) => c === undefined || c === 'PEN' || c === 'USD';
const KINDS = new Set(['rent', 'car', 'loan', 'card', 'internet', 'phone', 'insurance', 'education', 'services', 'taxes', 'subscription', 'other']);

/** Only the fields a photo reading may carry (validatePatch's own list); anything else in a stored card is dropped. */
const VISION_FIELDS: Record<string, readonly string[]> = {
  balance: ['t', 'amountMinor', 'currency'],
  obligation: ['t', 'kind', 'name', 'amountMinor', 'currency', 'approx', 'unknownAmount', 'day', 'dayMax'],
  debt: ['t', 'kind', 'name', 'lender', 'institution', 'last4', 'currency', 'balanceMinor', 'approx', 'unknownBalance', 'minimumMinor', 'dueDay'],
  account: ['t', 'institution', 'kind', 'last4'],
};
const pick = (x: Record<string, unknown>): Patch =>
  Object.fromEntries((VISION_FIELDS[x.t as string] ?? []).filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) as unknown as Patch;

export function validPatches(input: unknown): Patch[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 8).filter((p): p is Patch => {
    if (!p || typeof p !== 'object') return false;
    const x = p as Record<string, unknown>;
    if (!okCur(x.currency) || !okDay(x.day) || !okDay(x.dueDay) || !okDay(x.dayMax)) return false;
    if (![x.lender, x.institution].every((v) => v === undefined || (typeof v === 'string' && v.length <= 60))) return false;
    if (![x.approx, x.unknownAmount, x.unknownBalance].every((v) => v === undefined || typeof v === 'boolean')) return false;
    if (x.t === 'balance') return okMinor(x.amountMinor) && x.amountMinor !== undefined;
    if (x.t === 'obligation') return typeof x.name === 'string' && x.name.length <= 60 && KINDS.has(x.kind as string) && okMinor(x.amountMinor);
    if (x.t === 'debt') return typeof x.name === 'string' && x.name.length <= 60 && (x.kind === 'card' || x.kind === 'loan') && okMinor(x.balanceMinor) && okMinor(x.minimumMinor)
      && (x.last4 === undefined || (typeof x.last4 === 'string' && /^\d{4}$/.test(x.last4)));
    if (x.t === 'account') return x.kind === 'card' && typeof x.last4 === 'string' && /^\d{4}$/.test(x.last4);
    return false; // incomes, variables, removals never come from a photo
  }).map((p) => pick(p as unknown as Record<string, unknown>));
}

export function visionWrites(patches: readonly Patch[], existing: Existing, userId: string): PlannedWrites {
  const draft = mergePatches(emptyDraft(), validPatches(patches), null).draft;
  const w = domainWrites(draft, userId);
  const out: PlannedWrites = { inserts: [], updates: [] };
  const same = (a: string, b: string) => fold(a) === fold(b);
  for (const row of w.obligations) {
    const peers = existing.obligations.filter((o) => o.currency === row.currency);
    const match = peers.find((o) => same(o.name, row.name as string))
      ?? (row.kind !== 'other' ? (() => { const k = peers.filter((o) => o.kind === row.kind); return k.length === 1 ? k[0] : undefined; })() : undefined);
    if (!match) { out.inserts.push({ table: 'fixed_expenses', row }); continue; }
    const patch: Record<string, unknown> = {};
    if (row.amount_minor != null) Object.assign(patch, { amount_minor: row.amount_minor, amount_status: row.amount_status });
    if (row.due_day != null) Object.assign(patch, { due_day: row.due_day, due_day_max: null });
    if (Object.keys(patch).length) out.updates.push({ table: 'fixed_expenses', id: match.id, patch: { ...patch, updated_at: new Date().toISOString() } });
  }
  for (const row of w.debts) {
    const match = existing.debts.find((d) => d.currency === row.currency && same(d.name, row.name as string));
    if (!match) { out.inserts.push({ table: 'debts', row }); continue; }
    out.updates.push({ table: 'debts', id: match.id, patch: { balance_minor: row.balance_minor, ...(row.due_day != null ? { due_day: row.due_day } : {}) } });
  }
  for (const row of w.cards) if (!existing.cardLast4.includes(row.last4 as string)) out.inserts.push({ table: 'cards', row });
  if (w.balance) out.inserts.push({ table: 'balance_snapshots', row: w.balance });
  return out;
}
