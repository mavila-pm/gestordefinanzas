import { beforeEach, describe, expect, it, vi } from 'vitest';

/** markObligationPaidAction / convertToSubscriptionAction with Supabase stubbed (security review fixes). */
let tx: Record<string, unknown> | null = null;
let ob: Record<string, unknown> | null = null;
/** Earlier settlement rows of the same occurrence (abonos), as the settle path reads them. */
let prior: unknown[] = [];
const inserts: unknown[] = [];
const updates: unknown[] = [];
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../lib/learning', () => ({ logLearning: vi.fn(), decide: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'limit']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === 'transactions' ? tx : ob, error: null });
      q.then = (resolve: (v: unknown) => void) => resolve({ data: table === 'plan_settlements' ? prior : [], error: null });
      q.insert = async (row: unknown) => { inserts.push(row); return { error: null }; };
      q.update = (row: unknown) => { updates.push(row); return { eq: () => ({ neq: () => ({ select: async () => ({ data: [{ id: 'x' }], error: null }) }) }) }; };
      return q;
    },
  }),
  authUser: async () => ({ id: 'u1', email: null }),
}));
const UUID1 = '3f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f60', UUID2 = '4f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f61';
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe('confirming a payment', () => {
  beforeEach(() => { inserts.length = 0; tx = null; ob = null; prior = []; });
  it('a confirmed outgoing movement in the same currency settles the period', async () => {
    const { markObligationPaidAction } = await import('../app/app/plan/actions');
    tx = { type: 'credit_card_purchase', status: 'confirmed', currency: 'PEN', direction: 'outflow', amount_minor: 95000 }; ob = { currency: 'PEN', amount_minor: 95000, amount_status: 'confirmed' };
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10' }))).message).toBeTruthy();
    expect(inserts).toEqual([expect.objectContaining({ status: 'paid', transaction_id: UUID2 })]);
  });
  it('"Fue un abono": the status comes from REAL amounts (this movement + earlier abonos vs the plan), never the form', async () => {
    const { markObligationPaidAction } = await import('../app/app/plan/actions');
    ob = { currency: 'PEN', amount_minor: 150000, amount_status: 'confirmed' };
    tx = { type: 'expense', status: 'confirmed', currency: 'PEN', direction: 'outflow', amount_minor: 50000 };
    const first = await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial', amount: '1500' }));
    expect(first.message).toBe('Abono registrado. Faltan S/ 1,000.00.');
    // The second abono reaches the planned S/ 1,500 with the first one: the occurrence closes as paid.
    prior = [{ status: 'partial', tx: { amount_minor: 50000, currency: 'PEN', status: 'confirmed' } }];
    tx = { ...tx, amount_minor: 100000 };
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial' }))).message).toBe('Pago confirmado. El siguiente ya está en tus próximos pagos.');
    // An abono in another currency or not confirmed never counts toward the plan.
    prior = [{ status: 'partial', tx: { amount_minor: 100000, currency: 'USD', status: 'confirmed' } }, { status: 'partial', tx: { amount_minor: 100000, currency: 'PEN', status: 'review_required' } }];
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial' }))).message).toBe('Abono registrado. Faltan S/ 500.00.');
    expect(inserts.map((r) => (r as { status: string }).status)).toEqual(['partial', 'paid', 'partial']);
  });
  it('review M3: "Fue un abono" on an ESTIMATED amount stays partial even at the estimate, so the rest can still be linked', async () => {
    const { markObligationPaidAction } = await import('../app/app/plan/actions');
    ob = { currency: 'PEN', amount_minor: 10000, amount_status: 'estimated' }; // Luz ≈ S/ 100; the real bill is S/ 150
    tx = { type: 'expense', status: 'confirmed', currency: 'PEN', direction: 'outflow', amount_minor: 10000 };
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial' }))).message).toBe('Abono registrado. Falta confirmar el monto total.');
    prior = [{ status: 'partial', tx: { amount_minor: 10000, currency: 'PEN', status: 'confirmed' } }];
    tx = { ...tx, amount_minor: 5000 };
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial' }))).message).toBe('Abono registrado. Falta confirmar el monto total.');
    // The person closes it: "Pago completo".
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'full' }))).message).toBe('Pago confirmado. El siguiente ya está en tus próximos pagos.');
    expect(inserts.map((r) => (r as { status: string }).status)).toEqual(['partial', 'partial', 'paid']);
  });
  it('an occurrence already closed takes nothing more; an unknown price keeps the abono partial', async () => {
    const { markObligationPaidAction } = await import('../app/app/plan/actions');
    tx = { type: 'expense', status: 'confirmed', currency: 'PEN', direction: 'outflow', amount_minor: 50000 };
    ob = { currency: 'PEN', amount_minor: 150000, amount_status: 'confirmed' };
    prior = [{ status: 'skipped', tx: null }];
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial' }))).error).toBe('Ese pago ya estaba registrado.');
    expect(inserts).toHaveLength(0);
    prior = [];
    ob = { currency: 'PEN', amount_minor: null, amount_status: 'unknown' };
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10', mode: 'partial' }))).message).toBe('Abono registrado. Falta confirmar el monto total.');
    expect(inserts).toEqual([expect.objectContaining({ status: 'partial' })]);
  });
  it('PEN ≠ USD, income or pending movements never settle a payment', async () => {
    const { markObligationPaidAction } = await import('../app/app/plan/actions');
    for (const [t, o] of [
      [{ type: 'expense', status: 'confirmed', currency: 'USD', direction: 'outflow' }, { currency: 'PEN' }],
      [{ type: 'income', status: 'confirmed', currency: 'PEN', direction: 'inflow' }, { currency: 'PEN' }],
      [{ type: 'expense', status: 'review_required', currency: 'PEN', direction: 'outflow' }, { currency: 'PEN' }],
    ] as const) {
      tx = { ...t }; ob = { ...o };
      expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10' }))).error).toBe('Ese movimiento no es un pago confirmado en la misma moneda.');
    }
    expect(inserts).toHaveLength(0);
  });
});

describe('converting a payment into a subscription', () => {
  beforeEach(() => { updates.length = 0; });
  it('only an active payment naming a known service; never a card or loan payment', async () => {
    const { convertToSubscriptionAction } = await import('../app/app/compromisos/suscripciones/actions');
    ob = { name: 'Netflix', kind: 'other', active: true, ended_on: null };
    expect((await convertToSubscriptionAction({}, form({ id: UUID1 }))).message).toBeTruthy();
    for (const bad of [{ name: 'Visa BCP', kind: 'card' }, { name: 'Netflix', kind: 'loan' }, { name: 'Alquiler', kind: 'rent' }, { name: 'Netflix', kind: 'other', active: false }]) {
      ob = { active: true, ended_on: null, ...bad };
      expect((await convertToSubscriptionAction({}, form({ id: UUID1 }))).error).toBeTruthy();
    }
    expect(updates).toHaveLength(1);
  });
});
