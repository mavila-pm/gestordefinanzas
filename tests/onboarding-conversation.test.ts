import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { followUp } from '../lib/onboarding';
import { domainWrites } from '../src/ai/apply';
import { mergePatches, pendingReply, upcomingFromDraft, yesNoReply } from '../src/ai/draft';
import { interpret, readLoan } from '../src/ai/interpreter';
import { emptyDraft, type Draft } from '../src/ai/types';

/**
 * Onboarding as a conversation (no provider): the same order as lib/onboarding.ts — a reply only the pending
 * question can place → yes/no → the deterministic reading → merge → the short reply + ONE next question.
 */
function chat(today: string, ...messages: string[]): { draft: Draft; said: string[] } {
  let draft = emptyDraft();
  const said: string[] = [];
  for (const m of messages) {
    const answered = draft.pending;
    let merged = pendingReply(draft, m);
    if (!merged) {
      const yn = yesNoReply(draft, m);
      if (yn?.reask) { said.push(yn.reask); continue; }
      if (yn?.patches.length) merged = mergePatches(draft, yn.patches, null);
      else { const r = interpret(m); merged = mergePatches(draft, r.patches, r.bare); }
    }
    const next = followUp(merged.draft, merged.changed, today, answered);
    draft = next.draft;
    said.push(next.body);
  }
  return { draft, said };
}
const TODAY = '2026-10-09';
/** Skips income and balance so each test starts at the payments. */
const START = ['me pagan 4500 el 30', 'tengo 5000'];

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
    expect(said[2]).toBe('Ya tengo esos montos. ¿Qué día pagas el agua?');
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
    const { draft, said } = chat(TODAY, ...START, 'no tengo más pagos', 'sí, BCP', '2400', '120', 'el 25');
    expect(said[2]).toContain('¿Tienes tarjeta de crédito?');
    expect(said[3]).toContain('¿Cuánto debes ahora en la tarjeta BCP?');
    expect(said[4]).toContain('¿Cuál es el pago mínimo de la tarjeta BCP?');
    expect(said[5]).toContain('¿Qué día vence el pago de la tarjeta BCP?');
    expect(draft.debts[0]).toMatchObject({ kind: 'card', institution: 'BCP', balanceMinor: 240000, minimumMinor: 12000, dueDay: 25 });
  });
  it('9: card purchase ≠ card payment ≠ a second expense: one debt + ONE planned payment (the minimum), no movement', () => {
    const { draft } = chat(TODAY, ...START, 'no tengo más pagos', 'sí, BCP', '2400', '120', 'el 25');
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
    const { said } = chat(TODAY, ...START, 'no tengo más pagos', 'sí, BCP', '2400', '450', 'el 25', 'tengo un préstamo', 'BCP', 'Personal', '12 mil', '850', 'el 10', '36, llevo 10');
    expect(said.slice(3)).toEqual([
      'Anotado: tarjeta BCP. ¿Cuánto debes ahora en la tarjeta BCP?',
      'Listo, debes S/ 2,400. ¿Cuál es el pago mínimo de la tarjeta BCP?',
      'Listo, mínimo S/ 450. ¿Qué día vence el pago de la tarjeta BCP?',
      'Perfecto. Vence el 25. ¿Tienes algún préstamo?',
      'Anotado: préstamo. ¿Con qué banco o entidad es el préstamo?',
      'Anotado: préstamo BCP. ¿Qué tipo de préstamo es?',
      'Anotado: préstamo personal BCP. ¿Cuánto te falta pagar?',
      'Listo, debes S/ 12,000. ¿Cuánto pagas cada mes?',
      'Listo, cuota de S/ 850. ¿Qué día pagas la cuota?',
      'Perfecto. La cuota queda para el 10. ¿De cuántas cuotas es y cuántas llevas pagadas?',
      expect.stringMatching(/^Listo, llevas 10 de 36 cuotas\. ¿Cuánto gastas al mes en lo básico/),
    ]);
    expect(said.join(' ')).not.toMatch(/s\/ \d/);
  });
});

describe('the end: what comes until the next income, from the person + the engine', () => {
  it('lists the next payments chronologically with today\'s balance', () => {
    const { said } = chat('2026-10-09', 'me pagan 4500 el 30', 'tengo 5000', 'agua 120 el 15, internet 90 el 20', 'no tengo más pagos', 'sí, BCP', '2400', '450', 'el 25', 'no tengo', 'unos 800');
    expect(said.at(-1)).toBe('Ya lo tengo.\n\nHasta tu próximo ingreso vienen:\n• Agua · 15 oct · S/ 120\n• Internet · 20 oct · S/ 90\n• Tarjeta BCP · 25 oct · S/ 450\n\nY hoy tienes S/ 5,000 disponibles.');
  });
});
