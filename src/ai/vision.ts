import { BANK_LABEL } from './interpreter';
import { money } from './draft';
import type { VisionFacts } from './schema';
import type { Patch } from './types';

/**
 * Vision facts → proposed patches (§13, §18). Nothing here is applied: the person confirms or corrects first.
 * The engine (not the model) decides what the facts mean: a card statement is a card debt with its minimum
 * payment and due day; a bill is a service payment; a loan schedule is a loan debt.
 */
export interface VisionProposal { title: string; rows: Array<{ label: string; value: string; doubtful: boolean }>; patches: Patch[] }

const dayOf = (iso: string | null) => (iso ? Number(iso.slice(8, 10)) : undefined);
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'][Number(iso.slice(5, 7)) - 1]}`;

export function proposalFrom(f: VisionFacts): VisionProposal | null {
  const cur = f.currency ?? 'PEN';
  const inst = f.institution && BANK_LABEL[f.institution] ? f.institution : null;
  const doubt = (field: string) => f.confidence === 'low' || f.uncertain.includes(field);
  const rows: VisionProposal['rows'] = [];
  const add = (label: string, value: string | null, field: string) => { if (value) rows.push({ label, value, doubtful: doubt(field) }); };
  const patches: Patch[] = [];

  if (f.document === 'card_statement' || (f.paymentMinimumMinor !== null && f.document !== 'loan')) {
    const name = `Tarjeta${inst ? ` ${BANK_LABEL[inst]}` : ''}`;
    add('Deuda', f.balanceMinor !== null ? money(f.balanceMinor, cur) : null, 'balance');
    add('Pago mínimo', f.paymentMinimumMinor !== null ? money(f.paymentMinimumMinor, cur) : null, 'payment_minimum');
    add('Pago total', f.paymentTotalMinor !== null ? money(f.paymentTotalMinor, cur) : null, 'payment_total');
    add('Vence', f.dueDate ? shortDate(f.dueDate) : null, 'due_date');
    patches.push({ t: 'debt', kind: 'card', name, ...(inst ? { institution: inst } : {}), ...(f.last4 ? { last4: f.last4 } : {}), currency: cur,
      ...(f.balanceMinor !== null ? { balanceMinor: f.balanceMinor } : {}), ...(f.paymentMinimumMinor !== null ? { minimumMinor: f.paymentMinimumMinor } : {}),
      ...(dayOf(f.dueDate) ? { dueDay: dayOf(f.dueDate) } : {}) });
    if (inst || f.last4) patches.push({ t: 'account', institution: inst ?? 'OTRO', kind: 'card', ...(f.last4 ? { last4: f.last4 } : {}) });
    return rows.length ? { title: `${name}${f.last4 ? ` •••• ${f.last4}` : ''}`, rows, patches } : null;
  }
  if (f.document === 'loan') {
    const name = `Préstamo${inst ? ` ${BANK_LABEL[inst]}` : ''}`;
    add('Saldo', f.balanceMinor !== null ? money(f.balanceMinor, cur) : null, 'balance');
    add('Cuota', f.amountMinor !== null ? money(f.amountMinor, cur) : null, 'amount');
    add('Vence', f.dueDate ? shortDate(f.dueDate) : null, 'due_date');
    if (f.balanceMinor !== null) patches.push({ t: 'debt', kind: 'loan', name, ...(inst ? { institution: inst } : {}), currency: cur, balanceMinor: f.balanceMinor, ...(dayOf(f.dueDate) ? { dueDay: dayOf(f.dueDate) } : {}) });
    if (f.amountMinor !== null) patches.push({ t: 'obligation', kind: 'loan', name: `Cuota ${name.toLowerCase()}`, currency: cur, amountMinor: f.amountMinor, ...(dayOf(f.dueDate) ? { day: dayOf(f.dueDate) } : {}) });
    return rows.length ? { title: name, rows, patches } : null;
  }
  if (f.document === 'bill' || f.document === 'receipt') {
    const name = f.merchant ?? 'Servicio';
    add('Monto', f.amountMinor !== null ? money(f.amountMinor, cur) : null, 'amount');
    add('Vence', f.dueDate ? shortDate(f.dueDate) : null, 'due_date');
    if (f.document === 'bill' && (f.amountMinor !== null || f.dueDate)) {
      patches.push({ t: 'obligation', kind: /luz|enel|luz del sur|agua|sedapal|gas|calidda/i.test(name) ? 'services' : /claro|movistar|entel|bitel|win|internet/i.test(name) ? 'internet' : 'other',
        name, currency: cur, ...(f.amountMinor !== null ? { amountMinor: f.amountMinor } : {}), ...(dayOf(f.dueDate) ? { day: dayOf(f.dueDate) } : {}) });
    }
    return rows.length ? { title: name, rows, patches } : null;
  }
  if (f.balanceMinor !== null && f.document === 'bank_screen') {
    add('Saldo', money(f.balanceMinor, cur), 'balance');
    patches.push({ t: 'balance', amountMinor: f.balanceMinor, currency: cur });
    return { title: inst ? BANK_LABEL[inst]! : 'Tu cuenta', rows, patches };
  }
  return null;
}
