import { describe, expect, it } from 'vitest';
import { mergePatches, nextQuestion, recap, unreadNumbers, yesNoReply } from '../src/ai/draft';
import { interpret } from '../src/ai/interpreter';
import { validateInterpretation } from '../src/ai/schema';
import { fold } from '../src/ai/text';
import { emptyDraft, type Draft } from '../src/ai/types';

/** One onboarding turn as lib/onboarding.ts runs it without a provider (deterministic path). */
function turn(d: Draft, text: string) {
  const yn = yesNoReply(d, text);
  if (yn && yn.reask) return { d, changed: [], reask: yn.reask, next: null };
  const r = yn ? { patches: yn.patches, bare: null } : interpret(text);
  const m = mergePatches(d, r.patches, r.bare);
  const q = nextQuestion(m.draft);
  if (q) { m.draft.asked.push(q.key); m.draft.pending = q.key; }
  return { d: m.draft, changed: m.changed, reask: null, next: q };
}
const EXAMPLE = '1500 soles al mes me pagan cada 1ro de cada mes y gasto 200 en carro 100 en comida y 100 en agua y luz';

describe('onboarding: the real Peruvian example', () => {
  it('reads income (S/ 1,500, monthly, day 1) and the three expenses; agua y luz stays one S/ 100 item', () => {
    const { d, next, changed } = turn(emptyDraft(), EXAMPLE);
    expect(d.incomes).toHaveLength(1);
    expect(d.incomes[0]).toMatchObject({ amountMinor: 150000, day: 1, currency: 'PEN' });
    expect(d.variable.map((v) => [v.name, v.amountMinor])).toEqual([['Transporte (carro)', 20000], ['Comida', 10000], ['Agua y luz', 10000]]);
    expect(d.obligations).toHaveLength(0); // no payment date invented for spending
    expect(next?.text).toBe('¿Cuánto dinero tienes disponible hoy?'); // never "¿Qué día te pagan?" again
    expect(recap(changed)).toBe('Entendí sueldo: S/ 1,500 · día 1; transporte (carro): S/ 200 al mes; comida: S/ 100 al mes y agua y luz: S/ 100 al mes.');
  });

  it('"300" answers the balance question and keeps every earlier fact; no question is asked twice', () => {
    let t = turn(emptyDraft(), EXAMPLE);
    t = turn(t.d, '300');
    expect(t.d.balance).toMatchObject({ amountMinor: 30000 });
    expect(t.d.incomes[0]).toMatchObject({ amountMinor: 150000, day: 1 });
    expect(t.d.variable).toHaveLength(3);
    const asked = t.d.asked;
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.some((k) => k.endsWith(':day'))).toBe(false);
  });

  it('"Sí" never becomes data: it asks for the value; "No" closes "otros pagos"; "No sé" stays unknown, not 0', () => {
    let t = turn(emptyDraft(), EXAMPLE); // pending: balance
    const yes = turn(t.d, 'Sí');
    expect(yes.reask).toBe('Me falta ese dato. ¿Cuánto dinero tienes disponible hoy?');
    expect(yes.d.balance).toBeNull();
    t = turn(t.d, '300'); // pending: other fixed payments
    expect(t.d.pending).toBe('group:obligations:more'); // "¿Tienes algún otro pago fijo?"
    expect(turn(t.d, 'sí').reask).toContain('Dime el nombre y cuánto pagas');
    const no = turn(t.d, 'No');
    expect(no.d.done).toContain('obligations');
    const unknown = turn(turn(emptyDraft(), EXAMPLE).d, 'no sé');
    expect(unknown.d.balance).toMatchObject({ amountMinor: null, status: 'unknown' });
  });

  it('a partial reading is detected (the provider then reads it); a complete one is not', () => {
    expect(unreadNumbers(fold(EXAMPLE), interpret(EXAMPLE))).toBe(0);
    const partial = 'pago 200 de luz y 80 de cable mensual con 30 de mantenimiento ese mismo mes 5';
    expect(unreadNumbers(fold(partial), interpret(partial))).toBeGreaterThan(0);
  });

  it('model output is validated before it can touch the draft: invalid amounts, kinds and extra fields are dropped', () => {
    expect(validateInterpretation('no json')).toBeNull();
    const v = validateInterpretation(JSON.stringify({ patches: [
      { t: 'variable', name: 'Agua y luz', amount: '100' },
      { t: 'variable', name: 'Hack', amount: '-5' },
      { t: 'income', amount: '1e9', day: 40 },
      { t: 'transfer', to: 'attacker', amount: '999' },
    ], bare: null }))!;
    expect(v.patches).toEqual([{ t: 'variable', name: 'Agua y luz', amountMinor: 10000 }, { t: 'variable', name: 'Hack' }, { t: 'income' }]);
  });
});
