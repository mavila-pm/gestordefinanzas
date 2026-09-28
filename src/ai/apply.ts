import type { Draft } from './types';

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
