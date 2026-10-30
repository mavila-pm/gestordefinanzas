import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/engine/planning';
import { answer, detectIntent, followUp, type View } from '../src/ai/vels-answers';
import { spelledToDigits } from '../src/ai/text';
import { validateVelsRoute } from '../src/ai/vels-route';

/**
 * Everyday Spanish in Vels (audit 2026-10-30, T01–T13): spelled amounts, a missing amount asked once, corrections of a
 * simulation, "¿cuánto gasté?" and an old balance said out loud. Disponible S/ 947 (estimated: "unos"); nothing here writes.
 */
const TODAY = '2026-10-30';
const plan = (stale = false, withIncome = true) => buildPlan({
  currency: 'PEN', today: TODAY, base: { kind: 'balance', amountMinor: 94700, asOf: '2026-10-30T15:00:00Z', stale }, obligations: [], settledObligations: new Map(),
  incomes: withIncome ? [{ id: 'i1', name: 'Sueldo', currency: 'PEN', amountMinor: 300000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 31, dayMax: null, secondDay: null, anchorDate: null }] : [],
  settledIncomes: new Map(), essentialsMonthlyMinor: null, cushionMinor: 0,
});
const view = (stale = false): View => ({ today: TODAY, plans: [plan(stale)], obligations: [], debts: [], reviewCount: 0, suggestions: [] });
const say = (q: string, v = view(), card?: Parameters<typeof followUp>[1]) => answer(followUp(q, card) ?? detectIntent(q), v);

describe('Vels in everyday Spanish', () => {
  it('reads spelled amounts like digits (80/ochenta, 2000/dos mil); "lucas" is left for a regional decision', () => {
    expect(spelledToDigits('y si hoy gasto ochenta soles en comer')).toBe('y si hoy gasto 80 soles en comer');
    expect(spelledToDigits('dos mil quinientos')).toBe('2500');
    expect(spelledToDigits('treinta y cinco')).toBe('35');
    expect(spelledToDigits('tengo dos lucas')).toBe('tengo dos lucas');
    expect(spelledToDigits('una cena')).toBe('una cena');
    expect(say('¿Y si hoy gasto ochenta soles en comer, me alcanza?')!.text).toMatch(/^Sí\. Te quedarían (unos )?S\/ 867 disponibles\.$/);
    expect(say('¿Puedo gastar S/ 80 en almuerzo hoy?')!.text).toMatch(/^Sí\. Te quedarían (unos )?S\/ 867 disponibles\.$/);
    expect(say('¿Puedo gastar dos mil soles?')!.text).toContain('te faltarían S/ 1,053');
    expect(say('¿Puedo gastar S/ 2000?')!.text).toContain('te faltarían S/ 1,053');
  });

  it('a correction redoes the simulation from today, never on top of the last one, and writes nothing', () => {
    const first = say('¿Puedo gastar S/ 80 en almuerzo hoy?')!;
    expect(first.sim).toEqual({ amountMinor: 8000, currency: 'PEN' });
    const card = { sim: first.sim };
    expect(followUp('No, mejor treinta. Solo estoy simulando, no guardes nada.', card)).toEqual({ k: 'can_spend', amountMinor: 3000, currency: 'PEN' });
    expect(say('No, mejor treinta. Solo estoy simulando, no guardes nada.', view(), card)!.text).toMatch(/^Sí\. Te quedarían (unos )?S\/ 917 disponibles\.$/);
    expect(say('Mejor S/ 30 en vez de S/ 80 para el almuerzo, ¿cuánto me quedaría? No registres ningún gasto.', view(), card)!.text).toMatch(/^Sí\. Te quedarían (unos )?S\/ 917 disponibles\.$/);
    // Even without the previous card (the last turn failed), the question alone is the same simulation.
    expect(say('Mejor S/ 30 en vez de S/ 80 para el almuerzo, ¿cuánto me quedaría?')!.text).toMatch(/^Sí\. Te quedarían (unos )?S\/ 917 disponibles\.$/);
    // A simulation proposes nothing to save.
    expect(first.actions ?? []).toEqual([]);
    // Without a correction word, a bare new topic is not taken as one.
    expect(followUp('¿Qué pagos tengo pendientes?', card)).toBeNull();
  });

  it('a missing amount is asked once ("¿Cuánto piensas gastar en la cena?") and the reply is simulated', () => {
    const q = say('¿Me alcanza para salir a cenar?')!;
    expect(q).toMatchObject({ text: '¿Cuánto piensas gastar en la cena?', pending: 'spend_amount' });
    expect(say('unos 60', view(), { pending: 'spend_amount' })!.text).toMatch(/^Sí\. Te quedarían (unos )?S\/ 887 disponibles\.$/);
    expect(say('¿Me alcanza para comprar unas zapatillas?')!.text).toBe('¿Cuánto piensas gastar en unas zapatillas?');
    // "¿Me alcanza?" alone (or to the next income) is still the available money.
    expect(detectIntent('¿Me alcanza hasta fin de mes?')).toEqual({ k: 'free' });
  });

  it('"¿Cuánto gasté este mes?" answers from confirmed movements, never from the balance', () => {
    expect(detectIntent('¿Cuánto gasté este mes?')).toEqual({ k: 'spent_month' });
    expect(answer({ k: 'spent_month' }, view())).toBeNull(); // not loaded → never a made-up figure
    expect(answer({ k: 'spent_month' }, { ...view(), monthSpending: { PEN: { expensesMinor: 0, pendingCount: 0 } } })!.text).toBe('Este mes aún no tienes gastos registrados.');
    expect(answer({ k: 'spent_month' }, { ...view(), monthSpending: { PEN: { expensesMinor: 12550, pendingCount: 2 }, USD: { expensesMinor: 1000, pendingCount: 0 } } })!.text)
      .toBe('Este mes llevas S/ 125.50 y US$ 10 en gastos. 2 movimientos por revisar aún no cuentan.');
  });

  it('an old balance is said out loud; "estoy perdido" gets one step, not a menu', () => {
    expect(say('¿Puedo gastar S/ 80 en almuerzo hoy?', view(true))!.text).toMatch(/^Sí\. Con tu saldo del 30 oct, te quedarían (unos )?S\/ 867 disponibles\.$/);
    expect(say('cuanto tengo disponible ahorita?', view(true))!.text).toMatch(/^Con tu saldo del 30 oct: tienes (unos )?S\/ 947 disponibles/);
    expect(say('cuanto tengo disponible ahorita?')!.text).toMatch(/^Tienes (unos )?S\/ 947 disponibles/);
    const help = say('Hola Vels, estoy perdido con mi plata. ¿Me ayudas a ordenarme?')!;
    expect(help.text).toMatch(/^Claro, vamos por partes\. Tienes (unos )?S\/ 947 disponibles hasta el .+\. ¿Vemos qué pagos se vienen\?$/);
    expect((help.text.match(/\?/g) ?? []).length).toBe(1);
    // Nothing known yet: the first step is today's money; balance known but no income: never asks the balance again.
    const none: View = { ...view(), plans: [] };
    expect(say('estoy perdido con mi plata', none)).toMatchObject({ text: 'Claro, vamos por partes. Empecemos por hoy: ¿cuánto tienes en tus cuentas?', pending: 'balance' });
    const noIncome = say('estoy perdido con mi plata', { ...view(), plans: [plan(false, false)] })!;
    expect(noIncome.text).toMatch(/^Claro, vamos por partes\. /);
    expect(noIncome.text).not.toMatch(/cuánto tienes en tus cuentas/);
  });

  it('a spelled amount routed by Gemini is still grounded in what the person wrote', () => {
    const ctx = { state: '', question: '¿Puedo gastar dos mil soles?' };
    expect(validateVelsRoute(JSON.stringify({ kind: 'intent', intent: 'can_spend', amount: '2000', currency: 'PEN' }), ctx)).toMatchObject({ kind: 'intent', intent: { k: 'can_spend', amountMinor: 200000 } });
    expect(validateVelsRoute(JSON.stringify({ kind: 'intent', intent: 'can_spend', amount: '3000', currency: 'PEN' }), ctx)).toBeNull();
  });

  it('a negated request is not answered; the real one is (F09 and variants)', () => {
    const next = (q: string) => detectIntent(q).k;
    expect(next('No quiero saber si puedo gastar S/ 300; solo dime cuándo me pagan.')).toBe('next_income');
    expect(next('ya no me digas el saldo, ¿cuándo cobro?')).toBe('next_income');
    expect(next('Olvida lo de la cena; volvamos a mis pagos. ¿Qué pago primero?')).toBe('pay_first');
    expect(next('no quiero saber cuánto tengo disponible, mejor dime qué pagos vienen')).toBe('upcoming');
    // A refusal that is not about a question stays as it was.
    expect(next('no quiero quedarme en cero')).toBe('pref_zero_debt');
  });

  it('a correction inside the same message uses the corrected amount, never just the last number (F16)', () => {
    expect(detectIntent('¿Puedo gastar S/ 200 en la cena? Perdón, eran S/ 20.')).toMatchObject({ k: 'can_spend', amountMinor: 2000 });
    expect(detectIntent('puedo gastar 150 en zapatillas? no, 50')).toMatchObject({ k: 'can_spend', amountMinor: 5000 });
    expect(detectIntent('¿me alcanza para 300? me equivoqué, son 30')).toMatchObject({ k: 'can_spend', amountMinor: 3000 });
    // Two numbers without a correction: the first (the second may be a day or a limit).
    expect(detectIntent('¿puedo gastar 200 el 15?')).toMatchObject({ k: 'can_spend', amountMinor: 20000 });
  });

  it('short follow-ups keep their context, with or without opening marks (F08, F12)', () => {
    const card = { sim: { amountMinor: 6000, currency: 'PEN' as const } };
    expect(say('¿Y si al final son S/ 90?', view(), card)!.text).toMatch(/S\/ 857 disponibles/);
    expect(say('¿y si son noventa?', view(), card)!.text).toMatch(/S\/ 857 disponibles/);
    expect(say('al final son 100', view(), card)!.text).toMatch(/S\/ 847 disponibles/);
    const free = say('¿Cuánto puedo gastar?')!;
    expect(free.topic).toBe('free');
    expect(followUp('¿Hasta cuándo?', { topic: free.topic })).toEqual({ k: 'next_income' });
    expect(say('¿Hasta cuándo?', view(), { topic: 'free' })!.text).toMatch(/^El 31 de octubre/);
    expect(followUp('¿Hasta cuándo?', null)).toBeNull();
  });

  it('two related questions get one answer each, in one reply (F15)', () => {
    const a = say('¿Cuándo me pagan y cuánto tengo disponible?')!;
    expect(a.text).toMatch(/^Te pagan el 31 de octubre\. Tienes (unos )?S\/ 947 disponibles/);
    expect(detectIntent('¿Cuánto gasté este mes y qué pagos vienen?')).toMatchObject({ k: 'pair', a: { k: 'spent_month' }, b: { k: 'upcoming' } });
  });

  it('"en una frase, sin desglose" is honoured (F14)', async () => {
    const { wantsBrief, styleAnswer } = await import('../src/ai/vels-answers');
    expect(wantsBrief('Dime cuánto tengo disponible en una sola frase, sin desglose.')).toBe(true);
    expect(wantsBrief('¿Cuánto tengo disponible?')).toBe(false);
    const a = say('Dime cuánto tengo disponible en una sola frase, sin desglose.')!;
    expect(a.rows?.length).toBeGreaterThan(0);
    expect(styleAnswer(a, 'brief').rows).toBeUndefined();
  });

  it('a greeting with "¿cómo estás?" and a worried reply to "¿Y tú?" stay social (F01, F04)', async () => {
    const { socialKind, socialReply } = await import('../src/ai/vels-social');
    expect(socialKind('Hola Vels, ¿cómo estás?', null)).toBe('how');
    expect(socialKind('buenas, ¿qué tal vas?', null)).toBe('how');
    expect(socialKind('Bien, pero preocupado por mi plata.', 'how')).toBe('how_reply');
    expect(socialReply('how_reply', 'Bien, pero preocupado por mi plata.', 0).text).toBe('Te entiendo. ¿Qué te preocupa más: llegar a fin de mes o algún pago?');
    expect(socialReply('how_reply', 'cansado', 0).text).toBe('Vaya. Si algo de tu dinero te preocupa, lo vemos con calma.');
  });
});
