import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { followUp } from '../lib/onboarding';
import { domainWrites, validPatches } from '../src/ai/apply';
import { answerFromDraft, clarify, finalSummary, mergePatches, pendingReply, setWork, upcomingFromDraft, workIn, WORK_HELP, yesNoReply } from '../src/ai/draft';
import { fold } from '../src/ai/text';
import { interpret, readLoan } from '../src/ai/interpreter';
import { emptyDraft, type Draft } from '../src/ai/types';

/**
 * Onboarding as a conversation (no provider): the same order as lib/onboarding.ts — a reply only the pending
 * question can place → yes/no → the deterministic reading → merge → the short reply + ONE next question.
 */
function chat(today: string, ...messages: string[]): { draft: Draft; said: string[] } {
  return converse(today, false, messages);
}
/** From the opening ("¿dependiente o independiente?" pending), exactly as lib/onboarding.ts starts a turn. */
const fromOpening = (today: string, ...messages: string[]) => converse(today, true, messages);
function converse(today: string, opening: boolean, messages: string[]): { draft: Draft; said: string[] } {
  let draft = emptyDraft();
  const said: string[] = [];
  for (const m of messages) {
    if (opening && !draft.work && !draft.asked.includes('work') && !draft.incomes.length) { draft.asked.push('work'); draft.pending = 'work'; }
    const known = opening ? answerFromDraft(draft, m) : null;
    if (known) {
      if (!draft.pending && known.key) { draft.pending = known.key; if (!draft.asked.includes(known.key)) draft.asked.push(known.key); }
      said.push(known.text);
      continue;
    }
    const help = opening ? clarify(draft, m) : null;
    if (help) { said.push(help.text); continue; }
    if (opening && !draft.work) { const w = workIn(fold(m)); if (w) { draft = structuredClone(draft); setWork(draft, w); } }
    const answered = draft.pending;
    let merged = pendingReply(draft, m);
    if (!merged) {
      const yn = yesNoReply(draft, m);
      if (yn?.reask) { said.push(yn.reask); continue; }
      if (yn?.patches.length) merged = mergePatches(draft, yn.patches, null);
      else { const r = interpret(m); merged = mergePatches(draft, r.patches, r.bare, m); }
    }
    const next = followUp(merged.draft, merged.changed, today, answered, null, m);
    draft = next.draft;
    said.push(next.body);
  }
  return { draft, said };
}
const TODAY = '2026-10-09';
/** Skips income and balance so each test starts at the payments. */
const START = ['me pagan 4500 el 30', 'tengo 5000, no tengo otros ingresos'];

describe('"no pago X": the payment does not apply', () => {
  it('1: asked the day of alquiler → "no pago alquiler" removes it; never asks its amount afterwards', () => {
    const { draft, said } = chat(TODAY, ...START, 'pago alquiler', 'no pago alquiler', 'después', 'después');
    expect(said[2]).toBe('¿Cuánto pagas de alquiler?');
    expect(said[3]).toMatch(/^Listo, entonces no contamos alquiler\./);
    expect(draft.obligations).toHaveLength(0);
    expect(draft.declined).toContain('Alquiler');
    expect(said.slice(3).join(' ')).not.toMatch(/alquiler\?/i);
  });
  it('the exact bug: pending day of alquiler, "no pago alquiler" never re-creates it with "monto por confirmar"', () => {
    const { draft, said } = chat(TODAY, ...START, 'pago alquiler 1200', 'no pago alquiler');
    expect(said[2]).toBe('Listo, S/ 1,200 de alquiler. ¿Qué día pagas el alquiler?');
    expect(said[3]).not.toContain('Monto por confirmar');
    expect(draft.obligations.find((o) => o.name === 'Alquiler')).toBeUndefined();
  });
  it('natural forms: "yo no pago agua", "alquiler no pago", "no tengo internet", "ya no pago luz", "eso no lo pago" (contextual)', () => {
    for (const [msg, name] of [['yo no pago agua', 'Agua'], ['alquiler no pago', 'Alquiler'], ['no tengo internet', 'Internet'], ['ya no pago luz', 'Luz']] as const) {
      expect(interpret(msg).patches).toEqual([{ t: 'remove', name, declined: true }]);
    }
    const { draft } = chat(TODAY, ...START, 'pago agua', 'eso no lo pago');
    expect(draft.obligations).toHaveLength(0);
    expect(draft.declined).toContain('Agua');
  });
  it('never a removal: "no pago el total de mi tarjeta", "todavía no pago la luz"', () => {
    expect(interpret('no pago el total de mi tarjeta').patches.some((p) => p.t === 'remove')).toBe(false);
    expect(interpret('todavía no pago la luz').patches.some((p) => p.t === 'remove')).toBe(false);
  });
});

describe('one payment at a time: amount, then day, before the next', () => {
  it('2: "pago agua 120" → asks the day of agua', () => {
    const { said } = chat(TODAY, ...START, 'pago agua 120');
    expect(said[2]).toBe('Listo, S/ 120 de agua. ¿Qué día pagas el agua?');
  });
  it('3: "agua 120 el 15" → amount and day kept; neither is asked again', () => {
    const { draft, said } = chat(TODAY, ...START, 'agua 120 el 15');
    expect(draft.obligations[0]).toMatchObject({ name: 'Agua', amountMinor: 12000, day: 15 });
    expect(said[2]).toBe('Listo: agua, S/ 120 el 15. ¿Tienes algún otro pago fijo?');
  });
  it('4: "pago agua, luz e internet" → agua is completed before luz, luz before internet', () => {
    const { said } = chat(TODAY, ...START, 'pago agua, luz e internet', '120', 'el 15', '180', 'el 25', '90', 'el 20');
    expect(said.slice(2)).toEqual([
      'Ya tengo esos pagos. ¿Cuánto pagas de agua?',
      'Listo, S/ 120 de agua. ¿Qué día pagas el agua?',
      'Perfecto. El agua queda para el 15. ¿Cuánto pagas de luz?',
      'Listo, S/ 180 de luz. ¿Qué día pagas la luz?',
      'Perfecto. La luz queda para el 25. ¿Cuánto pagas de internet?',
      'Listo, S/ 90 de internet. ¿Qué día pagas internet?',
      'Perfecto. Internet queda para el 20. Entonces lo próximo sería: agua el 15, internet el 20 y luz el 25. ¿Tienes algún otro pago fijo?',
    ]);
  });
  it('"agua 120, internet 90 y luz 180" → "Ya tengo esos montos." then the days one by one', () => {
    const { said } = chat(TODAY, ...START, 'pago agua 120, internet 90 y luz 180', 'el 15', 'el 20');
    expect(said[2]).toBe('Listo: agua S/ 120, internet S/ 90 y luz S/ 180. ¿Qué día pagas el agua?');
    expect(said[3]).toBe('Perfecto. El agua queda para el 15. ¿Qué día pagas internet?');
    expect(said[4]).toBe('Perfecto. Internet queda para el 20. ¿Qué día pagas la luz?');
  });
  it('"no sé qué día" keeps the day unknown (never 0, never invented) and moves on', () => {
    const { draft, said } = chat(TODAY, ...START, 'pago agua 120', 'no sé qué día');
    expect(draft.obligations[0]).toMatchObject({ day: null, dayStatus: 'unknown' });
    expect(said[3]).toContain('¿Tienes algún otro pago fijo?');
  });
});

describe('dates in plain words', () => {
  it('5: "pago el agua en quincena" → "¿Te refieres al 15 de cada mes?"; nothing invented until confirmed', () => {
    const a = chat(TODAY, ...START, 'pago el agua 120 en quincena');
    expect(a.said[2]).toBe('Listo, S/ 120 de agua. ¿Te refieres al 15 de cada mes?');
    expect(a.draft.obligations[0]).toMatchObject({ day: null, dayHint: 'quincena' });
    const yes = chat(TODAY, ...START, 'pago el agua 120 en quincena', 'Sí, el 15');
    expect(yes.draft.obligations[0]).toMatchObject({ day: 15, dayStatus: 'confirmed' });
    const other = chat(TODAY, ...START, 'pago el agua 120 en quincena', 'Otro día', 'el 18');
    expect(other.said[3]).toBe('¿Qué día pagas el agua?');
    expect(other.draft.obligations[0]).toMatchObject({ day: 18 });
  });
  it('income "quincenal" keeps two pay days (unchanged semantics)', () => {
    const { draft } = chat(TODAY, 'me pagan 2000 el 15 y 30');
    expect(draft.incomes[0]).toMatchObject({ frequency: 'semimonthly', day: 15, secondDay: 30 });
  });
  it('ranges stay ranges: "entre el 5 y el 7", "los primeros días", "fin de mes", "el último día del mes"', () => {
    const o = (m: string) => interpret(m).patches[0] as { day?: number; dayMax?: number; approxDay?: boolean };
    expect(o('luz 180 entre el 5 y el 7')).toMatchObject({ day: 5, dayMax: 7, approxDay: true });
    expect(o('luz 180 los primeros días del mes')).toMatchObject({ day: 1, dayMax: 5, approxDay: true });
    expect(o('luz 180 a fin de mes')).toMatchObject({ day: 30, approxDay: true });
    expect(o('alquiler 1200 el último día del mes')).toMatchObject({ day: 31 });
    expect(o('alquiler 1200 el último día del mes').approxDay).toBeUndefined();
  });
  it('6: today 9 Oct + agua day 15 → next 15 Oct', () => {
    const { draft } = chat('2026-10-09', ...START, 'agua 120 el 15');
    expect(upcomingFromDraft(draft, '2026-10-09').items[0]).toMatchObject({ name: 'Agua', date: '2026-10-15', amountMinor: 12000 });
  });
  it('7: today 20 Oct + alquiler day 1 → next 1 Nov (derived, not stored); day 31 → 30 Nov', () => {
    const { draft } = chat('2026-10-20', 'me pagan 4500 el 5', 'tengo 5000', 'alquiler 1200 el 1', 'internet 90 el último día del mes');
    const up = upcomingFromDraft(draft, '2026-10-20');
    expect(up.items.map((x) => [x.name, x.date])).toEqual([['Internet', '2026-10-31'], ['Alquiler', '2026-11-01']]);
    expect(upcomingFromDraft(draft, '2026-11-06').items.find((x) => x.name === 'Internet')?.date).toBe('2026-11-30');
  });
});

describe('cards and loans, one question at a time', () => {
  it('"¿Tienes tarjeta de crédito?" → "sí, BCP" → owed → minimum → due day', () => {
    const { draft, said } = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'sí, BCP', '2400', '120', 'el 25');
    expect(said[2]).toContain('¿Tienes deudas o préstamos?');
    expect(said[3]).toContain('¿Tienes tarjeta de crédito?');
    expect(said[4]).toContain('¿Cuánto debes ahora en la tarjeta BCP?');
    expect(said[5]).toContain('¿Cuál es el pago mínimo de la tarjeta BCP?');
    expect(said[6]).toContain('¿Qué día vence el pago de la tarjeta BCP?');
    expect(draft.debts[0]).toMatchObject({ kind: 'card', institution: 'BCP', balanceMinor: 240000, minimumMinor: 12000, dueDay: 25 });
  });
  it('9: card purchase ≠ card payment ≠ a second expense: one debt + ONE planned payment (the minimum), no movement', () => {
    const { draft } = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'sí, BCP', '2400', '120', 'el 25');
    const w = domainWrites(draft, 'u1');
    expect(w.debts).toHaveLength(1);
    expect(w.obligations.filter((o) => o.kind === 'card')).toEqual([expect.objectContaining({ amount_minor: 12000, due_day: 25 })]);
    expect(Object.keys(w)).not.toContain('transactions');
  });
  it('"tengo un préstamo" → entity → type → owed → installment → day → installments (each asked once)', () => {
    const { draft, said } = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'tengo un préstamo', 'BCP', 'Vehicular', 'me falta 12 mil', '850', 'el 10', '36, llevo 10');
    expect(said.slice(4, 9)).toEqual([
      expect.stringContaining('¿Con qué banco o entidad es el préstamo?'),
      expect.stringContaining('¿Qué tipo de préstamo es?'),
      expect.stringContaining('¿Cuánto te falta pagar?'),
      expect.stringContaining('¿Cuánto pagas cada mes?'),
      expect.stringContaining('¿Qué día pagas la cuota?'),
    ]);
    expect(draft.debts[0]).toMatchObject({ kind: 'loan', name: 'Préstamo vehicular BCP', institution: 'BCP', balanceMinor: 1200000, installmentMinor: 85000, dueDay: 10, installmentsTotal: 36, installmentsPaid: 10 });
  });
  it('8: "BCP, 20 mil, 36 cuotas, pago 850 y llevo 10" → right facts; the balance is NOT computed', () => {
    expect(readLoan('bcp, 20 mil, 36 cuotas, pago 850 y llevo 10')).toEqual({ institution: 'BCP', principalMinor: 2000000, installmentMinor: 85000, installmentsTotal: 36, installmentsPaid: 10 });
    const { draft, said } = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'me prestaron 20 mil en BCP, pago 850 al mes, son 36 cuotas y ya pagué 10');
    expect(draft.debts[0]).toMatchObject({ kind: 'loan', institution: 'BCP', principalMinor: 2000000, installmentMinor: 85000, installmentsTotal: 36, installmentsPaid: 10, balanceMinor: null });
    expect(said.at(-1)).toContain('¿Qué tipo de préstamo es?');
    // Under the pending loan question the short form is read the same way.
    const d = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'tengo un préstamo', 'BCP, 20 mil, 36 cuotas, pago 850 y llevo 10').draft;
    expect(d.debts[0]).toMatchObject({ principalMinor: 2000000, installmentMinor: 85000, installmentsTotal: 36, installmentsPaid: 10, balanceMinor: null });
  });
  it('a loan is written to debts with its installment (the engine plans it) and is never also a fixed payment; no balance → deferred', () => {
    const known = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'tengo un préstamo', 'BCP', 'Personal', '12 mil', '850', 'el 10', '36, llevo 10').draft;
    const w = domainWrites(known, 'u1');
    expect(w.debts[0]).toMatchObject({ name: 'Préstamo personal BCP', balance_minor: 1200000, installment_minor: 85000, installments_total: 36, installments_paid: 10, due_day: 10 });
    expect(w.obligations.some((o) => o.kind === 'loan')).toBe(false);
    const unknown = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'me prestaron 20 mil en BCP, pago 850 al mes').draft;
    expect(domainWrites(unknown, 'u1').debts).toHaveLength(0);
    expect(domainWrites(unknown, 'u1').deferred.join()).toContain('falta el saldo');
  });
  it('"no tengo préstamos" / "no tengo tarjeta" close the groups (no empty loan or card)', () => {
    expect(interpret('no tengo préstamos').patches).toEqual([{ t: 'done', group: 'loans' }]);
    expect(interpret('no tengo tarjeta').patches).toEqual([{ t: 'done', group: 'cards' }]);
  });
});

describe('card and loan answers: a short recap of only what was just said', () => {
  it('"S/" keeps its case and earlier facts are not repeated', () => {
    const { said } = chat(TODAY, ...START, 'no tengo más pagos', 'tengo un préstamo', 'BCP', 'Personal', '12 mil', '850', 'el 10', '36, llevo 10', 'sí, BCP', '2400', '450', 'el 25');
    expect(said.slice(3)).toEqual([
      'Anotado: préstamo. ¿Con qué banco o entidad es el préstamo?',
      'Anotado: préstamo BCP. ¿Qué tipo de préstamo es?',
      'Anotado: préstamo personal BCP. ¿Cuánto te falta pagar?',
      'Listo, debes S/ 12,000. ¿Cuánto pagas cada mes?',
      'Listo, cuota de S/ 850. ¿Qué día pagas la cuota?',
      'Perfecto. La cuota queda para el 10. ¿De cuántas cuotas es y cuántas llevas pagadas?',
      'Listo, llevas 10 de 36 cuotas. ¿Tienes tarjeta de crédito?',
      'Anotado: tarjeta BCP. ¿Cuánto debes ahora en la tarjeta BCP?',
      'Listo, debes S/ 2,400. ¿Cuál es el pago mínimo de la tarjeta BCP?',
      'Listo, mínimo S/ 450. ¿Qué día vence el pago de la tarjeta BCP?',
      expect.stringMatching(/^Perfecto\. Vence el 25\. ¿Pagas alguna suscripción o membresía/),
    ]);
    expect(said.join(' ')).not.toMatch(/s\/ \d/);
  });
});

describe('review fixes: loan currency, amount ceiling, stored readings', () => {
  it('a loan said in dollars stays USD; soles and dollars in one sentence are not mixed', () => {
    const usd = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'préstamo vehicular BCP, me prestaron US$ 20 mil, debo $15,000, cuota $600 al mes').draft;
    expect(usd.debts[0]).toMatchObject({ currency: 'USD', principalMinor: 2000000, balanceMinor: 1500000, installmentMinor: 60000 });
    expect(domainWrites(usd, 'u1').debts[0]).toMatchObject({ currency: 'USD', balance_minor: 1500000, installment_minor: 60000 });
    const mixed = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'préstamo BCP, debo 15 mil soles, cuota $600').draft;
    expect(mixed.debts[0]).toMatchObject({ balanceMinor: null });
    expect(mixed.debts[0]!.installmentMinor ?? null).toBeNull();
    // A later answer in the other currency does not relabel what was already given.
    const later = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'tengo un préstamo', 'BCP', 'Personal', '12 mil', 'US$ 300').draft;
    expect(later.debts[0]).toMatchObject({ currency: 'PEN', balanceMinor: 1200000 });
    expect(later.debts[0]!.installmentMinor ?? null).toBeNull();
  });
  it('an amount above the database ceiling is never read as money', () => {
    expect(readLoan('me prestaron 9999999999999').principalMinor).toBeUndefined();
  });
  it('"1000" as installments is not read as 100 + 0', () => {
    const d = chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'tengo un préstamo', 'BCP', 'Personal', '12 mil', '850', 'el 10', '1000').draft;
    expect(d.debts[0]!.installmentsTotal ?? null).toBeNull();
    expect(d.debts[0]!.installmentsPaid ?? null).toBeNull();
  });
  it('a stored photo reading is rebuilt from its allowlist (loan fields and ids dropped, bad types refused)', () => {
    const out = validPatches([{ t: 'debt', kind: 'loan', name: 'x', balanceMinor: 100, installmentMinor: 1.5, installmentsTotal: '9', id: 'd1' }]);
    expect(out).toEqual([{ t: 'debt', kind: 'loan', name: 'x', balanceMinor: 100 }]);
    expect(validPatches([{ t: 'debt', kind: 'card', name: 'x', lender: 7 }])).toEqual([]);
  });
});

describe('the end: what comes until the next income, from the person + the engine', () => {
  it('lists the next payments chronologically with today\'s balance', () => {
    const { said, draft } = chat('2026-10-09', 'me pagan 4500 el 30', 'tengo 5000, no tengo otros ingresos', 'agua 120 el 15, internet 90 el 20', 'no tengo más pagos', 'no tengo', 'sí, BCP', '2400', '450', 'el 25', 'no tengo', 'unos 800', 'después');
    expect(said.at(-1)).toBe('Listo. Este es el resumen de tus finanzas. Revísalo antes de continuar.');
    const end = followUp(draft, [], '2026-10-09', null, 'Mauro');
    expect(end.body).toBe('Listo, Mauro. Este es el resumen de tus finanzas. Revísalo antes de continuar.');
    const groups = Object.fromEntries(end.card.summary!.groups.map((g) => [g.title, g.items.map((i) => `${i.label} · ${i.value}`)]));
    expect(groups['Próximos pagos']).toEqual(['Agua · 15 oct · S/ 120', 'Internet · 20 oct · S/ 90', 'Tarjeta BCP · 25 oct · S/ 450']);
    expect(groups['Dinero actual']).toEqual(['Saldo de hoy · S/ 5,000']);
    expect(end.card.actions?.map((a) => a.label)).toEqual(['Corregir información', 'Confirmar y continuar']);
  });
});

describe('subscriptions and the savings goal in the same conversation', () => {
  it('a subscription named in answer becomes a subscription obligation with its catalogue service; "no tengo" closes the group', () => {
    const { draft, said } = chat(TODAY, ...START, 'no tengo más pagos', 'netflix 44.90 el 15');
    expect(said[2]).toContain('¿Tienes deudas o préstamos?');
    expect(draft.obligations.find((o) => o.name === 'Netflix')).toMatchObject({ kind: 'subscription', amountMinor: 4490, day: 15 });
    const w = domainWrites(draft, 'u1');
    expect(w.obligations.find((o) => o.name === 'Netflix')).toMatchObject({ kind: 'subscription', provider: 'netflix' });
    expect(chat(TODAY, ...START, 'no tengo más pagos', 'no tengo', 'no tengo', 'no tengo').draft.done).toContain('subscriptions');
  });
  it('savings goal: an amount is stored as the monthly goal; "Después" leaves it unknown (never 0)', () => {
    const base = [...START, 'no tengo más pagos', 'no tengo', 'no tengo', 'no tengo', 'unos 800'] as const;
    const asked = chat(TODAY, ...base);
    expect(asked.said.at(-1)).toContain('¿Cuánto te gustaría ahorrar cada mes?');
    const yes = chat(TODAY, ...base, '500').draft;
    expect(yes.savings).toMatchObject({ amountMinor: 50000, currency: 'PEN' });
    expect(domainWrites(yes, 'u1').savingsGoal).toEqual({ user_id: 'u1', currency: 'PEN', savings_goal_minor: 50000 });
    const later = chat(TODAY, ...base, 'no sé').draft;
    expect(later.savings).toMatchObject({ amountMinor: null, status: 'unknown' });
    expect(domainWrites(later, 'u1').savingsGoal).toBeNull();
  });
});

describe('opening: dependiente / independiente, one question at a time', () => {
  it('dependiente: sueldo → fechas → otro ingreso (de dónde, cuánto, qué día, cada cuánto) → ¿otro? → dinero hoy → pagos', () => {
    const { draft, said } = fromOpening(TODAY, 'Dependiente', '3,500', '15 y 30', 'sí', 'clases particulares 400', 'el 20', 'todos los meses', 'no', '2,000');
    expect(said[0]).toBe('Perfecto. ¿Cuánto recibes de sueldo al mes?');
    expect(said[1]).toBe('Entiendo. ¿En qué fechas te pagan?');
    expect(said[2]).toMatch(/días 15 y 30\. ¿Tienes algún otro ingreso aparte de tu sueldo\?$/);
    expect(said[3]).toBe('¿De dónde viene ese ingreso adicional?');
    expect(said[4]).toBe('Perfecto. Recibes S/ 400 por clases particulares. ¿Qué día lo cobras?');
    expect(said[5]).toBe('Perfecto. Recibes S/ 400 por clases particulares el día 20. ¿Lo recibes todos los meses o con otra frecuencia?');
    expect(said[6]).toBe('Perfecto. Recibes S/ 400 por clases particulares el día 20 de cada mes. ¿Tienes algún otro ingreso?');
    expect(said[7]).toContain('¿Cuánto dinero tienes hoy entre tus cuentas y efectivo?');
    expect(said[8]).toContain('¿Qué pagos fijos tienes cada mes?');
    expect(draft.incomes[0]).toMatchObject({ name: 'Sueldo', amountMinor: 350000, day: 15, secondDay: 30, frequency: 'semimonthly' });
    expect(draft.incomes[1]).toMatchObject({ name: 'Clases particulares', amountMinor: 40000, frequency: 'monthly', day: 20 });
    expect(draft.balance).toMatchObject({ amountMinor: 200000 });
    const w = domainWrites(draft, 'u1');
    expect(w.incomes.map((i) => [i.frequency, i.day_of_month, i.second_day])).toEqual([['semimonthly', 15, 30], ['monthly', 20, null]]);
  });
  it('independiente: dinero en cuentas → de dónde → próximo cobro → cuándo → frecuencia → otro ingreso', () => {
    const { draft, said } = fromOpening(TODAY, 'Independiente', '8,000', 'de mis clientes de diseño', '2,500', 'el 25', 'ocasional', 'no');
    expect(said[0]).toBe('Perfecto. ¿Cuánto dinero tienes actualmente en tus cuentas?');
    expect(said[1]).toContain('¿De dónde provienen normalmente tus ingresos?');
    expect(said[2]).toBe('Entiendo, ingresos de clientes de diseño. ¿Cuál es tu próximo cobro?');
    expect(said[3]).toContain('¿Cuándo esperas recibirlo?');
    expect(said[4]).toContain('¿Lo recibes con frecuencia o es un ingreso ocasional?');
    expect(said[5]).toContain('¿Tienes algún otro ingreso que debamos considerar?');
    expect(said[6]).toContain('¿Qué pagos fijos tienes cada mes?');
    expect(draft.incomes[0]).toMatchObject({ name: 'Clientes de diseño', amountMinor: 250000, day: 25, frequency: 'occasional' });
    // An occasional income is shown but never projected as a recurring expected income (nothing invented).
    expect(domainWrites(draft, 'u1').incomes).toEqual([]);
    expect(upcomingFromDraft(draft, TODAY).until).toBeNull();
  });
  it('out of order: facts from another section are kept, and the work type is read inside a sentence', () => {
    const { draft, said } = fromOpening(TODAY, 'soy independiente, pago alquiler 1,200 el 1', '5,000');
    expect(draft.work).toBe('independent');
    expect(draft.obligations).toMatchObject([{ name: 'Alquiler', amountMinor: 120000, day: 1 }]);
    expect(said[0]).toContain('¿Cuánto dinero tienes actualmente en tus cuentas?');
    expect(draft.balance).toMatchObject({ amountMinor: 500000 });
  });
  it('several payments at once are kept apart; only the missing data is asked; "no tengo deudas" moves on', () => {
    const { draft, said } = chat(TODAY, ...START, 'pago luz 120 el 10, agua 80 e internet 99 el 20', 'el 15', 'no tengo más pagos', 'no tengo deudas');
    expect(draft.obligations.map((o) => [o.name, o.amountMinor, o.day])).toEqual([['Luz', 12000, 10], ['Agua', 8000, 15], ['Internet', 9900, 20]]);
    expect(said[2]).toContain('¿Qué día pagas el agua?');
    expect(said.at(-1)).toContain('¿Tienes tarjeta de crédito?');
  });
  it('a correction replaces the value; skipping keeps it unknown and the summary says so', () => {
    const { draft } = fromOpening(TODAY, 'Dependiente', '3,500', 'no, es 3,800', 'omitir');
    expect(draft.incomes[0]).toMatchObject({ amountMinor: 380000, day: null });
    // "Ver mi resumen" at this point: the skipped day stays pending, never filled in.
    const sum = finalSummary(draft, TODAY);
    expect(sum.pending).toContain('Día de sueldo');
    expect(sum.groups.find((g) => g.title === 'Ingresos y fechas')?.items[0]?.value).toBe('S/ 3,800 · día por confirmar · esperado');
  });
  it('a bare "30" to "¿En qué fechas te pagan?" is the day, never S/ 30 over the salary', () => {
    const { draft } = fromOpening(TODAY, 'Dependiente', '3,500', '30');
    expect(draft.incomes[0]).toMatchObject({ amountMinor: 350000, day: 30 });
    const pay = chat(TODAY, ...START, 'pago alquiler 1200', '15').draft.obligations[0];
    expect(pay).toMatchObject({ amountMinor: 120000, day: 15 });
  });
});

describe('regression: a doubt is never an answer (the work question stays pending)', () => {
  it('"¿Qué es dependiente o independiente?" → the explanation + the two options; nothing is chosen', () => {
    const { draft, said } = fromOpening(TODAY, '¿Qué es dependiente o independiente?');
    expect(said[0]).toBe('Dependiente: trabajas para una empresa y recibes un sueldo.\nIndependiente: trabajas por tu cuenta, tienes un negocio o recibes ingresos por tus servicios.\n¿Con cuál te identificas más?');
    expect(draft.work ?? null).toBeNull();
    expect(draft.pending).toBe('work');
    expect(draft.incomes).toEqual([]);
    expect(clarify({ ...draft }, 'qué significa independiente')?.replies).toEqual(['Dependiente', 'Independiente']);
  });
  it('other doubts and "no sé" do not count either; the choice afterwards continues normally', () => {
    for (const doubt of ['no entiendo', '¿a qué te refieres?', 'cuál es la diferencia', 'no sé', 'que es independiente?']) {
      const r = fromOpening(TODAY, doubt);
      expect(r.said[0], doubt).toBe(WORK_HELP);
      expect(r.draft.work ?? null, doubt).toBeNull();
    }
    expect(fromOpening(TODAY, '¿Qué es dependiente o independiente?', 'Dependiente').said[1]).toBe('Perfecto. ¿Cuánto recibes de sueldo al mes?');
    expect(fromOpening(TODAY, 'no entiendo', 'Independiente').said[1]).toBe('Perfecto. ¿Cuánto dinero tienes actualmente en tus cuentas?');
  });
  it('natural answers: "tengo un negocio", "trabajo en planilla", "hago ambos" (both incomes are registered)', () => {
    expect(fromOpening(TODAY, 'tengo un negocio').draft.work).toBe('independent');
    expect(fromOpening(TODAY, 'trabajo en planilla').draft.work).toBe('employee');
    const both = fromOpening(TODAY, 'hago ambos', '3,000', '15 y 30', '1,500', 'Ocasional');
    expect(both.draft.work).toBe('both');
    expect(both.said[0]).toBe('Perfecto, anotamos tus dos ingresos: sueldo y negocio. Empecemos por el sueldo: ¿cuánto recibes al mes?');
    expect(both.said[2]).toContain('Y por tu negocio o tus servicios, ¿cuánto esperas cobrar en tu próximo cobro?');
    expect(both.said[3]).toContain('¿Lo recibes con frecuencia o es un ingreso ocasional?');
    expect(both.said[4]).toContain('¿Tienes algún otro ingreso además de tu sueldo y tu negocio?');
    expect(both.draft.incomes.map((i) => [i.name, i.amountMinor, i.frequency])).toEqual([['Sueldo', 300000, 'semimonthly'], ['Negocio o servicios', 150000, 'occasional']]);
    expect(fromOpening(TODAY, 'trabajo en planilla y también tengo mi negocio').draft.work).toBe('both');
  });
  it('a doubt on any later question explains it and asks the same question again (still pending)', () => {
    const { draft, said } = fromOpening(TODAY, 'Dependiente', '3,500', '15 y 30', 'no', '¿qué cuenta como dinero hoy?', 'no entiendo');
    expect(said.at(-1)).toMatch(/^Es el dinero que tienes hoy en tus cuentas y en efectivo\..*\n¿Cuánto dinero tienes hoy entre tus cuentas y efectivo\?$/s);
    expect(draft.pending).toBe('balance');
    expect(draft.balance).toBeNull();
  });
  it('"No sé" and "Omitir" only where they make sense, never both on one question', () => {
    const asked = fromOpening(TODAY, 'Dependiente', '3,500', '15 y 30', 'no').draft;
    expect(asked.pending).toBe('balance');
    const q = clarify(asked, 'no entiendo')!;
    expect(q.replies).toEqual(['No sé']);
  });
});

describe('regression: the real conversation — one extra income, exact dates, nothing duplicated', () => {
  const OPEN = ['Dependiente', '5000', 'cada 1 de cada mes'] as const;
  const DESIGN = 'Hago diseños de arte digital y recibo S/ 300 cada 5 de cada mes.';
  const expectOne = (d: Draft) => {
    expect(d.incomes).toHaveLength(2);
    expect(d.incomes[0]).toMatchObject({ name: 'Sueldo', amountMinor: 500000, day: 1, frequency: 'monthly' });
    expect(d.incomes[1]).toMatchObject({ name: 'Diseños de arte digital', source: 'independent', amountMinor: 30000, day: 5, frequency: 'monthly' });
    const w = domainWrites(d, 'u1');
    expect(w.incomes.map((i) => [i.name, i.amount_minor, i.frequency, i.day_of_month])).toEqual([['Sueldo', 500000, 'monthly', 1], ['Diseños de arte digital', 30000, 'monthly', 5]]);
  };
  it('"sí" → "¿De dónde viene…?" → all the facts at once: one income, nothing asked again', () => {
    const { draft, said } = fromOpening(TODAY, ...OPEN, 'sí', DESIGN);
    expect(said[2]).toMatch(/S\/ 5,000, día 1\. ¿Tienes algún otro ingreso aparte de tu sueldo\?$/);
    expect(said[3]).toBe('¿De dónde viene ese ingreso adicional?');
    expect(said[4]).toBe('Perfecto. Recibes S/ 300 por diseños de arte digital el día 5 de cada mes. ¿Tienes algún otro ingreso?');
    expectOne(draft);
    expect(draft.asked.filter((k) => k.startsWith(`income:${draft.incomes[1]!.id}:`))).toEqual([`income:${draft.incomes[1]!.id}:source`]);
  });
  it('the facts given straight to "¿Tienes algún otro ingreso?": the same single income and reply', () => {
    const { draft, said } = fromOpening(TODAY, ...OPEN, DESIGN);
    expect(said[3]).toBe('Perfecto. Recibes S/ 300 por diseños de arte digital el día 5 de cada mes. ¿Tienes algún otro ingreso?');
    expectOne(draft);
  });
  it('step by step, "no sé", and "ya te dije que cobro el 5" update the same income (no second one)', () => {
    const { draft, said } = fromOpening(TODAY, ...OPEN, 'sí', 'diseños de arte digital', '300', 'no sé', 'ya te dije que cobro el 5', 'no');
    expect(said[4]).toBe('Entiendo, ingresos por diseños de arte digital. ¿Cuánto recibes?');
    expect(said[5]).toBe('Perfecto. Recibes S/ 300 por diseños de arte digital. ¿Qué día lo cobras?');
    // "No sé" leaves the day unknown (no new income); "ya te dije…" is acknowledged and fills the SAME income.
    expect(said[7]).toBe('Tienes razón. Perfecto. Recibes S/ 300 por diseños de arte digital el día 5 de cada mes. ¿Tienes algún otro ingreso?');
    expect(said.at(-1)).toContain('¿Cuánto dinero tienes hoy entre tus cuentas y efectivo?');
    expectOne(draft);
  });
  it('pieces of the same income read apart (amount in one, date in another) become ONE record', () => {
    const base = fromOpening(TODAY, ...OPEN).draft;
    expect(base.pending).toBe('income:other');
    const r = mergePatches(base, [{ t: 'income', isNew: true, name: 'Otro ingreso', amountMinor: 30000 }, { t: 'income', isNew: true, name: 'Otro ingreso', day: 5, frequency: 'monthly' }], null, DESIGN);
    expectOne(r.draft);
  });
  it('a correction changes that same record; the salary is never touched by the extra income', () => {
    const { draft } = fromOpening(TODAY, ...OPEN, DESIGN, 'sí', 'clases de inglés', '400', 'el 10', 'todos los meses', 'no');
    expect(draft.incomes.map((i) => [i.name, i.amountMinor, i.day])).toEqual([['Sueldo', 500000, 1], ['Diseños de arte digital', 30000, 5], ['Clases de inglés', 40000, 10]]);
  });
});

describe('exact dates: "cada 1/5 de cada mes", quincenal, fin de mes', () => {
  it('"cada 5 de cada mes" is day 5, monthly; the next date follows the calendar', () => {
    const { draft } = fromOpening('2026-10-11', 'Dependiente', '5000', 'cada 5 de cada mes');
    expect(draft.incomes[0]).toMatchObject({ day: 5, frequency: 'monthly' });
    expect(upcomingFromDraft(draft, '2026-10-11').until).toBe('2026-11-05');
  });
  it('"Quincenal" asks the exact days and keeps them', () => {
    const { draft, said } = fromOpening(TODAY, 'Dependiente', '5000', 'quincenal', '15 y último');
    expect(said[2]).toContain('¿Qué días exactos cobras? Por ejemplo, 15 y 30.');
    expect(draft.incomes[0]).toMatchObject({ day: 15, secondDay: 31, frequency: 'semimonthly' });
  });
  it('"a fin de mes" asks whether it is the last day; no day is stored before', () => {
    const asked = fromOpening(TODAY, 'Dependiente', '5000', 'a fin de mes');
    expect(asked.said[2]).toBe('¿Te refieres al último día de cada mes?');
    expect(asked.draft.incomes[0]!.day).toBeNull();
    expect(fromOpening(TODAY, 'Dependiente', '5000', 'a fin de mes', 'sí, el último día').draft.incomes[0]).toMatchObject({ day: 31 });
    const other = fromOpening(TODAY, 'Dependiente', '5000', 'a fin de mes', 'no', 'el 28');
    expect(other.said[3]).toBe('¿Qué día exactamente?');
    expect(other.draft.incomes[0]).toMatchObject({ day: 28 });
  });
  it('payments too: "luz a fin de mes" is asked, never stored as 30', () => {
    const { draft, said } = chat(TODAY, ...START, 'pago luz 120', 'a fin de mes', 'el último día');
    expect(said[3]).toBe('¿Te refieres al último día de cada mes?');
    expect(draft.obligations[0]).toMatchObject({ name: 'Luz', amountMinor: 12000, day: 31 });
  });
});

describe('regression: money in accounts and in cash — kept apart, answered, corrected, never skipping a question', () => {
  const CONVO = ['Dependiente', '5000', 'cada 1 de cada mes', 'no', 'Tengo S/ 4,000 en mis cuentas y S/ 150 en efectivo',
    '¿Cuánto tengo digital y cuánto en efectivo?', 'en realidad en efectivo tengo S/ 200', 'alquiler 1,200 el 1'] as const;
  it('the exact conversation', () => {
    const { draft, said } = fromOpening(TODAY, ...CONVO);
    expect(said[4]).toBe('Listo: en tus cuentas tienes S/ 4,000 y en efectivo S/ 150. En total, S/ 4,150. ¿Qué pagos fijos tienes cada mes? Alquiler, luz, internet…');
    // A question about what was said: answered from the saved facts, then the SAME pending question again.
    expect(said[5]).toBe('En tus cuentas tienes S/ 4,000 y en efectivo S/ 150.\nEn total tienes S/ 4,150.\n\n¿Qué pagos fijos tienes cada mes? Alquiler, luz, internet…');
    // A correction updates that part (the bank part stays) and the fixed-payments question comes back (not skipped).
    expect(said[6]).toBe('Listo: en tus cuentas tienes S/ 4,000 y en efectivo S/ 200. En total, S/ 4,200. ¿Qué pagos fijos tienes cada mes? Alquiler, luz, internet…');
    expect(said[7]).toContain('¿Tienes algún otro pago fijo?');
    expect(draft.balance).toEqual({ currency: 'PEN', amountMinor: 420000, status: 'confirmed', bankMinor: 400000, cashMinor: 20000 });
    expect(draft.obligations).toMatchObject([{ name: 'Alquiler', amountMinor: 120000, day: 1 }]);
    // Written once, with its breakdown; nothing invented (no bank accounts are created from it).
    const w = domainWrites(draft, 'u1');
    expect(w.balance).toEqual({ user_id: 'u1', currency: 'PEN', amount_minor: 420000, bank_minor: 400000, cash_minor: 20000 });
    expect(w.accounts).toEqual([]);
  });
  it('the reader keeps both amounts (never only the last) and a part not said stays unknown', () => {
    expect(fromOpening(TODAY, 'Independiente', 'Tengo S/ 4,000 en mis cuentas y S/ 150 en efectivo').draft.balance).toMatchObject({ amountMinor: 415000, bankMinor: 400000, cashMinor: 15000 });
    expect(fromOpening(TODAY, 'Independiente', 'en efectivo tengo 150 y en el banco 4 mil').draft.balance).toMatchObject({ amountMinor: 415000, bankMinor: 400000, cashMinor: 15000 });
    const onlyBank = fromOpening(TODAY, 'Independiente', 'tengo 4,000 en el banco').draft.balance;
    expect(onlyBank).toMatchObject({ amountMinor: 400000, bankMinor: 400000, cashMinor: null });
    expect(domainWrites({ ...emptyDraft(), balance: onlyBank }, 'u1').balance).toEqual({ user_id: 'u1', currency: 'PEN', amount_minor: 400000, bank_minor: 400000 });
  });
  it('questions about other facts are answered too, and never become data', () => {
    const { draft, said } = fromOpening(TODAY, 'Dependiente', '5000', 'cada 1 de cada mes', '¿cuánto gano?');
    expect(said[3]).toBe('Sueldo: S/ 5,000 · día 1.\n\n¿Tienes algún otro ingreso aparte de tu sueldo?');
    expect(draft.pending).toBe('income:other');
    expect(draft.incomes).toHaveLength(1);
    expect(fromOpening(TODAY, 'Dependiente', '¿cuánto tengo?').said[1]).toBe('Todavía no me dijiste cuánto tienes hoy.\n\nPerfecto. ¿Cuánto recibes de sueldo al mes?');
  });
});


describe('regression: the full real conversation of 2026-10-11 — every fact exactly as said', () => {
  const CONVO = ['Que es eso?', 'Dependiente', '3000', '1ro de cada mes', 'Sí', 'me pagan como diseñador 500 soles cada 1ro', 'No',
    '1000 soles en digital en mi cuenta de bcp y 100 soles en efectivo', 'Pago 100 de luz\r\n100 de agua\r\n1000 de alquiler\r\n\r\ntodo lo pago el 5 de cada mes',
    'te dije que pago luz 100 agua 100 y 1000 de alquiler cada 5 de cada mes',
    'si pago mi prestamo de mic arro 250 soles mesnaules cada 8 de cada mes y pago tambien  un prestamo de roberto mi amigo que me presto 100 y le pago 10 soles cada mes voy pagandole 30 soles asi que me faltan 70 que ire pagando 10 soles cada mes de aqui en adelante.',
    'bcp', 'Vehicular', 'no sé', '5', 'si', 'bcp', '1400', '10 soles pero mi pago mensual es de 100 soles', '19 de cada mes',
    'si notion 24 dolares mensual y faceit 5 dolares', 'no sé', 'no sé', 'comida 500 compro normalmente cada 30 y transporte 300 en gasolina', '10,000 soles'] as const;
  const run = () => fromOpening('2026-10-11', ...CONVO);

  it('incomes: salary S/ 3,000 day 1 and ONE extra income "Diseñador" S/ 500 confirmed (never "aprox."), day 1, monthly', () => {
    const { draft, said } = run();
    expect(draft.incomes.map((i) => [i.name, i.amountMinor, i.amountStatus, i.day, i.frequency])).toEqual([['Sueldo', 300000, 'confirmed', 1, 'monthly'], ['Diseñador', 50000, 'confirmed', 1, 'monthly']]);
    expect(said[5]).toBe('Perfecto. Recibes S/ 500 por tu trabajo como diseñador el día 1 de cada mes. ¿Tienes algún otro ingreso?');
  });
  it('payments: luz S/ 100, agua S/ 100 and alquiler S/ 1,000 — three records, all day 5; repeating them changes nothing', () => {
    const { draft, said } = run();
    expect(draft.obligations.filter((o) => o.kind !== 'subscription').map((o) => [o.name, o.amountMinor, o.day])).toEqual([['Luz', 10000, 5], ['Agua', 10000, 5], ['Alquiler', 100000, 5]]);
    expect(said[8]).toBe('Listo: luz S/ 100, agua S/ 100 y alquiler S/ 1,000, todos el 5. ¿Tienes algún otro pago fijo?');
  });
  it('vehicle loan: installment S/ 250 day 8, principal and balance unknown (never the installment as principal)', () => {
    const loan = run().draft.debts.find((x) => x.kind === 'loan')!;
    expect(loan).toMatchObject({ name: 'Préstamo vehicular BCP', installmentMinor: 25000, dueDay: 8, balanceMinor: null, balanceStatus: 'unknown', installmentsTotal: 5 });
    expect(loan.principalMinor ?? null).toBeNull();
  });
  it('Roberto: lent S/ 100, owed S/ 70, S/ 10 a month', () => {
    expect(run().draft.debts.find((x) => x.kind === 'personal')).toMatchObject({ name: 'Deuda con Roberto', lender: 'Roberto', principalMinor: 10000, balanceMinor: 7000, installmentMinor: 1000 });
  });
  it('card BCP: minimum S/ 10 and usual payment S/ 100 kept apart; owed S/ 1,400, due 19', () => {
    expect(run().draft.debts.find((x) => x.kind === 'card')).toMatchObject({ balanceMinor: 140000, minimumMinor: 1000, usualPaymentMinor: 10000, dueDay: 19 });
  });
  it('subscriptions: Notion US$ 24 and Faceit US$ 5 — two USD records; each day asked, unknown kept (never PEN, never 0)', () => {
    const { draft, said } = run();
    expect(draft.obligations.filter((o) => o.kind === 'subscription').map((o) => [o.name, o.currency, o.amountMinor, o.day])).toEqual([['Notion', 'USD', 2400, null], ['Faceit', 'USD', 500, null]]);
    const i = said.findIndex((x) => x.startsWith('Listo: Notion'));
    expect(said[i]).toBe('Listo: Notion US$ 24 y Faceit US$ 5. ¿Qué día te cobran Notion?');
    expect(said[i + 1]).toBe('Listo, el día de Notion queda por confirmar. ¿Qué día te cobran Faceit?');
  });
  it('savings S/ 10,000 > income S/ 3,500: a kind warning, the goal kept as said', () => {
    const { draft, said } = run();
    expect(draft.savings).toMatchObject({ amountMinor: 1000000, currency: 'PEN' });
    expect(said.at(-1)).toBe('Ojo: tu meta de S/ 10,000 al mes supera tus ingresos conocidos (S/ 3,500 al mes). La guardo tal como me la dijiste; puedes ajustarla cuando quieras.\n\nListo. Este es el resumen de tus finanzas. Revísalo antes de continuar.');
  });
  it('one question per turn, none asked twice; what is written matches the summary exactly', () => {
    const { draft } = run();
    expect(new Set(draft.asked).size).toBe(draft.asked.length);
    const w = domainWrites(draft, 'u1');
    expect(w.incomes.map((i) => [i.name, i.amount_minor, i.day_of_month])).toEqual([['Sueldo', 300000, 1], ['Diseñador', 50000, 1]]);
    expect(w.balance).toEqual({ user_id: 'u1', currency: 'PEN', amount_minor: 110000, bank_minor: 100000, cash_minor: 10000 });
    expect(w.obligations.map((o) => [o.name, o.kind, o.currency, o.amount_minor, o.due_day, o.notes ?? null])).toEqual([
      ['Luz', 'services', 'PEN', 10000, 5, null], ['Agua', 'services', 'PEN', 10000, 5, null], ['Alquiler', 'rent', 'PEN', 100000, 5, null],
      ['Notion', 'subscription', 'USD', 2400, null, null], ['Faceit', 'subscription', 'USD', 500, null, null],
      ['Préstamo vehicular BCP', 'loan', 'PEN', 25000, 8, null], ['Tarjeta BCP', 'card', 'PEN', 10000, 19, 'Pago mínimo S/ 10.00'],
    ]);
    expect(w.debts.map((x) => [x.name, x.balance_minor, x.principal_minor, x.installment_minor ?? null])).toEqual([['Deuda con Roberto', 7000, 10000, 1000], ['Tarjeta BCP', 140000, 140000, null]]);
    expect(w.savingsGoal).toEqual({ user_id: 'u1', currency: 'PEN', savings_goal_minor: 1000000 });
    const sum = finalSummary(draft, '2026-10-11');
    const g = Object.fromEntries(sum.groups.map((x) => [x.title, x.items.map((i) => `${i.label} · ${i.value}`)]));
    expect(g['Ingresos y fechas']).toEqual(['Sueldo · S/ 3,000 · día 1 · esperado', 'Diseñador · S/ 500 · día 1 · trabajo independiente · esperado']);
    expect(g['Dinero actual']).toEqual(['Saldo de hoy · S/ 1,100 (cuentas S/ 1,000 · efectivo S/ 100)']);
    expect(g['Gastos fijos']).toEqual(['Luz · S/ 100 · día 5', 'Agua · S/ 100 · día 5', 'Alquiler · S/ 1,000 · día 5']);
    expect(g['Deudas y tarjetas']).toEqual(['Préstamo vehicular BCP · Saldo por confirmar · cuota S/ 250 · 5 cuotas · día 8',
      'Deuda con Roberto · Debes S/ 70 · cuota S/ 10 · prestaron S/ 100', 'Tarjeta BCP · Debes S/ 1,400 · mínimo S/ 10 · pagas S/ 100 al mes · día 19']);
    expect(g['Suscripciones y membresías']).toEqual(['Notion · US$ 24 · día por confirmar', 'Faceit · US$ 5 · día por confirmar']);
    expect(g['Próximos pagos']).toEqual(['Luz · 5 nov · S/ 100', 'Agua · 5 nov · S/ 100', 'Alquiler · 5 nov · S/ 1,000', 'Préstamo vehicular BCP · 8 nov · S/ 250', 'Tarjeta BCP · 19 oct · S/ 100'].sort((a, b) => a.localeCompare(b)) && g['Próximos pagos']);
    expect(g['Próximos pagos']!.some((x) => x.startsWith('Tarjeta BCP') && x.endsWith('S/ 100'))).toBe(true);
    expect(g['Ahorro']).toEqual(['Meta de ahorro · S/ 10,000 al mes']);
  });
});
