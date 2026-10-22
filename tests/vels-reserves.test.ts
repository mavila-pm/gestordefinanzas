import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, type Reserve } from '../src/engine/planning';
import { answer, detectIntent, type View } from '../src/ai/vels-answers';

/**
 * Vels and Apartados (ADR-0017): "¿cuánto llevo para el viaje?" and "aparta 200 para el viaje" are answered locally
 * (0 AI quota) from the engine; a move is only a proposal card, written when the person taps it, through the same
 * path as the screen (lib/reserves.ts → SQL guard). Supabase and the planning loader are in memory.
 */
const TODAY = '2026-10-01';
type Row = Record<string, unknown>;
const RID = '3f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f60';
const store = { messages: [] as Array<{ role: string; body: string; card: Row | null }>, entries: [] as Row[], saved: 30000, active: true };
const trip = (o: Partial<Reserve> = {}): Reserve => ({ id: RID, name: 'Viaje', currency: 'PEN', savedMinor: store.saved, targetMinor: 120000, targetDate: '2026-12-30', ...o });
const infer = vi.fn(async () => ({ ok: false, reason: 'unavailable' }));

const planInput = () => ({
  currency: 'PEN' as const, today: TODAY, base: { kind: 'balance' as const, amountMinor: 500000, asOf: `${TODAY}T10:00:00Z`, stale: false }, obligations: [], settledObligations: new Map(),
  incomes: [{ id: 'sal', name: 'Sueldo', currency: 'PEN' as const, amountMinor: 400000, amountStatus: 'confirmed' as const, frequency: 'monthly' as const, dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null }],
  settledIncomes: new Map(), essentialsMonthlyMinor: 0, cushionMinor: 0, reserves: [trip()],
});
const planningData = () => ({
  today: TODAY, obligations: [], obligationRows: [], incomes: planInput().incomes, settledObligations: new Map(), settledIncomes: new Map(), suggestions: [], incomeMatches: [],
  recentIncome: null, debts: [], balances: { PEN: { amountMinor: 500000, asOf: `${TODAY}T10:00:00Z`, stale: false } }, reserves: [trip()],
});

vi.mock('server-only', () => ({}));
vi.mock('../lib/planning', () => ({
  loadPlanningData: async () => planningData(),
  planFor: () => buildPlan(planInput()),
  planInputFor: () => planInput(),
  planTimeline: () => [],
}));
vi.mock('../lib/cards', () => ({ loadCardViews: async () => [] }));
vi.mock('../lib/queries', () => ({ loadProfile: async () => ({ displayName: 'Mauro', givenNames: 'Mauro', familyNames: 'Ávila' }) }));
vi.mock('../lib/learning', () => ({ logLearning: async () => undefined }));
vi.mock('../lib/subscriptions', () => ({ loadSubscriptions: async () => null }));
vi.mock('../lib/preferences', () => ({ loadPreferences: async () => ({ velsStyle: 'balanced', velsProactive: true, primaryCurrency: 'PEN', primaryAccountId: null, notifyUpcoming: true, notifyReview: true, notifyMonthly: true, notifyLimits: true }) }));
vi.mock('../lib/plan-applications', () => ({ applyPlan: async () => ({ ok: false, error: 'x' }) }));
vi.mock('../lib/onboarding', () => ({ loadMessages: async () => store.messages.slice(-8), readImages: async () => [] }));
vi.mock('../lib/ai', () => ({ infer, STOP_TEXT: { ai_quota: 'q', failed: 'f', unavailable: 'u' } }));

function fakeDb() {
  const q = (table: string) => {
    const b: Record<string, unknown> = {
      insert(r: Row) {
        if (table === 'conversation_messages') store.messages.push({ role: r.role as string, body: r.body as string, card: (r.card as Row) ?? null });
        if (table === 'reserve_entries') {
          // The SQL guard (migration 053) in miniature: never more out than saved; one row per client_ref.
          if (r.direction === 'out' && (r.amount_minor as number) > store.saved) return Promise.resolve({ error: { code: '23514', message: 'reserve_insufficient' } });
          if (store.entries.some((e) => e.client_ref && e.client_ref === r.client_ref)) return Promise.resolve({ error: { code: '23505', message: 'reserve_entries_client_ref' } });
          store.entries.push(r);
          store.saved += (r.direction === 'in' ? 1 : -1) * (r.amount_minor as number);
          return Promise.resolve({ error: null });
        }
        return b;
      },
      select: () => b, eq: () => b, in: () => b, order: () => b, range: () => b, limit: () => b, delete: () => b,
      maybeSingle: async () => ({ data: table === 'reserves' ? { name: 'Viaje', currency: 'PEN', active: store.active } : table === 'reserve_balances' ? { saved_minor: store.saved } : null, error: null }),
      then: (ok: (x: unknown) => void) => ok({ data: [], error: null, count: 0 }),
    };
    return b;
  };
  return { from: q } as never;
}
async function turn(text: string) {
  const { velsTurn } = await import('../lib/vels');
  await velsTurn(fakeDb(), 'u1', text);
  return store.messages.at(-1)!;
}
const view = (reserves: Reserve[] = [trip()]): View => ({ today: TODAY, plans: [buildPlan(planInput())], obligations: [], debts: [], reviewCount: 0, suggestions: [], reserves });

beforeEach(() => { store.messages = []; store.entries = []; store.saved = 30000; store.active = true; infer.mockClear(); });

describe('detectIntent: Apartados, without stealing other questions', () => {
  it('status and moves', () => {
    expect(detectIntent('¿Cuánto llevo para el viaje?')).toEqual({ k: 'reserve_status', name: 'viaje', explicit: false });
    expect(detectIntent('cuánto tengo apartado para el viaje a Cusco')).toEqual({ k: 'reserve_status', name: 'viaje a cusco', explicit: true });
    expect(detectIntent('¿Cómo va mi apartado del SOAT?')).toEqual({ k: 'reserve_status', name: 'soat', explicit: true });
    expect(detectIntent('aparta 200 para el viaje')).toEqual({ k: 'reserve_move', name: 'viaje', direction: 'in', amountMinor: 20000, currency: null, explicit: true });
    expect(detectIntent('Sepárame S/ 150.50 para el viaje, por favor')).toMatchObject({ k: 'reserve_move', direction: 'in', amountMinor: 15050, currency: 'PEN', explicit: false });
    expect(detectIntent('usa 100 del viaje')).toEqual({ k: 'reserve_move', name: 'viaje', direction: 'out', amountMinor: 10000, currency: null, explicit: false });
    expect(detectIntent('saca 50 dólares del apartado del viaje')).toMatchObject({ k: 'reserve_move', name: 'viaje', direction: 'out', amountMinor: 5000, currency: 'USD', explicit: true });
  });
  it('other questions keep their meaning', () => {
    expect(detectIntent('¿Cuánto tengo en mi cuenta?').k).not.toMatch(/^reserve/);
    expect(detectIntent('¿Cuánto tengo para gastar?').k).not.toMatch(/^reserve/);
    expect(detectIntent('aparta la plata').k).toBe('apply_plan');
    expect(detectIntent('guarda el plan').k).toBe('apply_plan');
    expect(detectIntent('¿Puedo gastar 200 en el viaje?').k).toBe('can_spend');
  });
  it('review M1: free-money, balance, debt and cash questions are never read as an apartado', () => {
    // Same intent as before Apartados existed (the week questions stay local, 0 AI quota).
    expect(detectIntent('¿cuánto tengo para gastar esta semana?')).toEqual({ k: 'upcoming', range: 'week' });
    expect(detectIntent('cuanto tengo para comer esta semana')).toEqual({ k: 'upcoming', range: 'week' });
    for (const q of ['¿cuánto tengo para gastar hoy?', 'cuanto tengo para gastar hasta fin de mes', 'cuanto tengo de deuda', 'cuanto tengo de saldo',
      '¿cuánto tengo en la tarjeta?', '¿cuánto tengo en mi cuenta bcp?', 'cuanto tengo en efectivo', 'cuanto tengo en total', 'cuanto tengo para pagar el alquiler',
      'saca 200 del cajero', 'usa 100 de la tarjeta', 'ahorra 200 al mes', 'cuanto tengo en mi cuenta de ahorros']) {
      expect(detectIntent(q).k, q).not.toMatch(/^reserve/);
    }
  });
  it('review M1: a generic shape is answered only when it names one of the person\'s apartados', () => {
    const generic = detectIntent('cuanto tengo para el viaje');
    expect(generic).toEqual({ k: 'reserve_status', name: 'viaje', explicit: false });
    // Someone with apartados, none called like that: not ours (null → the normal flow), never "No tengo un apartado".
    expect(answer({ k: 'reserve_status', name: 'gastar hoy', explicit: false }, view())).toBeNull();
    expect(answer({ k: 'reserve_status', name: 'el fin de semana', explicit: false }, view())).toBeNull();
    expect(answer({ k: 'reserve_move', name: 'alquiler', direction: 'in', amountMinor: 50000, currency: null, explicit: false }, view())).toBeNull();
    expect(answer({ k: 'reserve_move', name: 'boda', direction: 'in', amountMinor: 50000, currency: null, explicit: true }, view())!.text)
      .toBe('No tengo un apartado para boda. Créalo en Dinero disponible y luego me dices cuánto apartar.');
    // Whole words only: an apartado called "a" never matches "gastar".
    expect(answer({ k: 'reserve_status', name: 'gastar', explicit: false }, view([trip({ name: 'a' })]))).toBeNull();
    expect(answer({ k: 'reserve_status', name: 'viaje a cusco', explicit: false }, view())!.text).toMatch(/^Llevas S\/ 300 de S\/ 1,200 para Viaje/);
  });
});

describe('answer(): engine numbers only', () => {
  it('"¿cuánto llevo para el viaje?" → saved, target, what is left and the monthly amount (reserveProgress)', () => {
    expect(answer({ k: 'reserve_status', name: 'viaje', explicit: false }, view())!.text)
      .toBe('Llevas S/ 300 de S/ 1,200 para Viaje: te faltan S/ 900. Si apartas S/ 300 al mes, llegas al 30 dic.');
    expect(answer({ k: 'reserve_status', name: 'viaje', explicit: false }, view([trip({ savedMinor: 120000 })]))!.text).toBe('Llevas S/ 1,200 de S/ 1,200 para Viaje. Ya llegaste a tu meta.');
    expect(answer({ k: 'reserve_status', name: 'viaje', explicit: false }, view([trip({ targetMinor: null, targetDate: null })]))!.text).toBe('Llevas S/ 300 apartados para Viaje. No tiene meta.');
  });
  it('unknown apartado: said only when the question is clearly about one (otherwise not ours to answer)', () => {
    expect(answer({ k: 'reserve_status', name: 'boda', explicit: true }, view([]))!.text).toBe('No tengo un apartado para boda. ¿Lo creas en Dinero disponible?');
    expect(answer({ k: 'reserve_status', name: 'boda', explicit: false }, view([]))).toBeNull();
  });
  it('"aparta 200 para el viaje" → a confirmation card (nothing written); "usa" more than saved → refused; PEN ≠ USD', () => {
    expect(answer({ k: 'reserve_move', name: 'viaje', direction: 'in', amountMinor: 20000, currency: null, explicit: true }, view())).toEqual({
      text: '¿Aparto S/ 200 para Viaje? No es un gasto: sigue en tu saldo, pero deja de estar disponible.',
      actions: [{ type: 'act', label: 'Sí, apartar', act: 'reserve_in', fields: { reserveId: RID, amount: '20000' } }],
    });
    expect(answer({ k: 'reserve_move', name: 'viaje', direction: 'out', amountMinor: 40000, currency: null, explicit: false }, view())!.text).toBe('Solo tienes S/ 300 apartados en Viaje.');
    expect(answer({ k: 'reserve_move', name: 'viaje', direction: 'in', amountMinor: 5000, currency: 'USD', explicit: true }, view())!.text).toBe('Tu apartado Viaje es en soles: no mezclo monedas.');
  });
});

describe('the whole turn: local (0 AI quota) and writes only on confirmation', () => {
  it('"¿cuánto llevo para el viaje?" never calls the model', async () => {
    const m = await turn('¿Cuánto llevo para el viaje?');
    expect(m.body).toBe('Llevas S/ 300 de S/ 1,200 para Viaje: te faltan S/ 900. Si apartas S/ 300 al mes, llegas al 30 dic.');
    expect(infer).not.toHaveBeenCalled();
  });

  it('"aparta 200 para el viaje" → card with a one-time ref; tapping it writes one entry; a replayed tap writes none', async () => {
    const m = await turn('aparta 200 para el viaje');
    expect(store.entries).toHaveLength(0); // a proposal, not a write
    expect(infer).not.toHaveBeenCalled();
    const act = (m.card!.acts as Array<{ act: string; fields: Record<string, string> }>)[0]!;
    expect(act).toMatchObject({ act: 'reserve_in', fields: { reserveId: RID, amount: '20000' } });
    expect(act.fields.ref).toMatch(/^vels:[0-9a-f-]{36}$/);
    const { velsAct } = await import('../lib/vels');
    expect(await velsAct(fakeDb(), 'u1', act.act, act.fields)).toBe('Listo. Apartaste S/ 200 para Viaje. Llevas S/ 500.');
    expect(await velsAct(fakeDb(), 'u1', act.act, act.fields)).toBe('Listo. Apartaste S/ 200 para Viaje. Llevas S/ 500.');
    expect(store.entries).toEqual([{ user_id: 'u1', reserve_id: RID, direction: 'in', amount_minor: 20000, client_ref: act.fields.ref }]);
  });

  it('a tampered button (bad amount / more than saved) never writes', async () => {
    const { velsAct } = await import('../lib/vels');
    expect(await velsAct(fakeDb(), 'u1', 'reserve_in', { reserveId: RID, amount: '-5' })).toBe('No pude hacerlo.');
    expect(await velsAct(fakeDb(), 'u1', 'reserve_out', { reserveId: RID, amount: '99999999' })).toBe('Solo tienes S/ 300 apartados en Viaje.');
    expect(await velsAct(fakeDb(), 'u1', 'reserve_in', { reserveId: 'x', amount: '100' })).toBe('No pude hacerlo.');
    expect(store.entries).toHaveLength(0);
  });
});
