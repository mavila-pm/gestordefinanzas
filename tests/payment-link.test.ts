import { beforeEach, describe, expect, it, vi } from 'vitest';

/** markObligationPaidAction / convertToSubscriptionAction with Supabase stubbed (security review fixes). */
let tx: Record<string, unknown> | null = null;
let ob: Record<string, unknown> | null = null;
const inserts: unknown[] = [];
const updates: unknown[] = [];
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../lib/learning', () => ({ logLearning: vi.fn(), decide: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === 'transactions' ? tx : ob, error: null });
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
  beforeEach(() => { inserts.length = 0; tx = null; ob = null; });
  it('a confirmed outgoing movement in the same currency settles the period', async () => {
    const { markObligationPaidAction } = await import('../app/app/plan/actions');
    tx = { type: 'credit_card_purchase', status: 'confirmed', currency: 'PEN', direction: 'outflow' }; ob = { currency: 'PEN' };
    expect((await markObligationPaidAction({}, form({ obligationId: UUID1, transactionId: UUID2, period: '2026-10' }))).message).toBeTruthy();
    expect(inserts).toHaveLength(1);
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
