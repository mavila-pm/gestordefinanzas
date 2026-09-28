import { mergePatches } from './draft';
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
  /** What stays "Por confirmar" in the draft (not writable yet). */
  deferred: string[];
}

export function domainWrites(d: Draft, userId: string): DomainWrites {
  const w: DomainWrites = { incomes: [], obligations: [], debts: [], accounts: [], cards: [], balance: null, settings: null, deferred: [] };
  for (const i of d.incomes) {
    if (i.day === null) { w.deferred.push(`${i.name}: falta el día`); continue; }
    const semi = i.frequency === 'semimonthly' && i.secondDay !== null;
    w.incomes.push({
      user_id: userId, name: i.name.slice(0, 60), currency: i.currency, amount_minor: i.amountMinor, amount_status: i.amountMinor === null ? 'unknown' : i.amountStatus,
      frequency: semi ? 'semimonthly' : 'monthly', day_of_month: i.day, day_max: !semi && i.dayMax && i.dayMax > i.day && i.dayMax - i.day <= 7 ? i.dayMax : null,
      second_day: semi ? i.secondDay : null,
    });
  }
  for (const o of d.obligations) {
    w.obligations.push({
      user_id: userId, name: o.name.slice(0, 60), kind: o.kind, currency: o.currency, amount_minor: o.amountMinor, amount_status: o.amountMinor === null ? 'unknown' : o.amountStatus,
      frequency: 'monthly', due_day: o.day, due_day_max: o.day !== null && o.dayMax && o.dayMax > o.day && o.dayMax - o.day <= 7 ? o.dayMax : null,
    });
  }
  for (const x of d.debts) {
    if (x.balanceMinor !== null) {
      w.debts.push({
        user_id: userId, name: x.name.slice(0, 60), lender: (x.lender ?? x.institution)?.slice(0, 60) ?? null, currency: x.currency,
        principal_minor: x.balanceMinor, balance_minor: x.balanceMinor, due_day: x.dueDay,
      });
    } else w.deferred.push(`${x.name}: falta el saldo`);
    // The card's monthly payment is an obligation (card payment is never an expense; it is a planned outflow).
    if (x.kind === 'card' && (x.minimumMinor !== null || x.dueDay !== null) && !d.obligations.some((o) => o.kind === 'card')) {
      w.obligations.push({
        user_id: userId, name: x.name.slice(0, 60), kind: 'card', currency: x.currency, amount_minor: x.minimumMinor,
        amount_status: x.minimumMinor === null ? 'unknown' : 'estimated', frequency: 'monthly', due_day: x.dueDay, due_day_max: null,
      });
    }
  }
  for (const a of d.accounts) {
    const institution = KNOWN_INSTITUTIONS.has(a.institution) ? a.institution : null;
    if (a.kind === 'card') {
      if (a.last4) w.cards.push({ user_id: userId, institution_code: institution, alias: `Tarjeta ${a.institution === 'OTRO' ? '' : a.institution}`.trim().slice(0, 60), kind: 'credit', currency: 'PEN', last4: a.last4 });
      continue;
    }
    w.accounts.push({ user_id: userId, institution_code: institution, alias: (institution ?? a.institution).slice(0, 60), currency: 'PEN' });
  }
  if (d.balance?.amountMinor != null) w.balance = { user_id: userId, currency: d.balance.currency, amount_minor: d.balance.amountMinor };
  const known = d.variable.filter((v) => v.amountMinor !== null && v.currency === 'PEN');
  if (known.length) w.settings = { user_id: userId, currency: 'PEN', essentials_monthly_minor: known.reduce((s, v) => s + v.amountMinor!, 0) };
  for (const v of d.variable) if (v.amountMinor === null) w.deferred.push(`${v.name}: falta el monto`);
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

export function validPatches(input: unknown): Patch[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 8).filter((p): p is Patch => {
    if (!p || typeof p !== 'object') return false;
    const x = p as Record<string, unknown>;
    if (!okCur(x.currency) || !okDay(x.day) || !okDay(x.dueDay)) return false;
    if (x.t === 'balance') return okMinor(x.amountMinor) && x.amountMinor !== undefined;
    if (x.t === 'obligation') return typeof x.name === 'string' && x.name.length <= 60 && KINDS.has(x.kind as string) && okMinor(x.amountMinor);
    if (x.t === 'debt') return typeof x.name === 'string' && x.name.length <= 60 && (x.kind === 'card' || x.kind === 'loan') && okMinor(x.balanceMinor) && okMinor(x.minimumMinor)
      && (x.last4 === undefined || (typeof x.last4 === 'string' && /^\d{4}$/.test(x.last4)));
    if (x.t === 'account') return x.kind === 'card' && typeof x.last4 === 'string' && /^\d{4}$/.test(x.last4);
    return false; // incomes, variables, removals never come from a photo
  });
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
