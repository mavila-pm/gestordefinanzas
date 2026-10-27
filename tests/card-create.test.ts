import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Alta de tarjeta (createCardAction) with Supabase stubbed: identity + optional credit cycle in one step. */
const inserted: Array<Record<string, unknown>> = [];
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: () => ({ insert: (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: 'c1' }, error: null }) }) }; } }),
    rpc: async () => ({ data: 0, error: null }),
  }),
  authUser: async () => ({ id: 'u1', email: null }),
}));
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe('createCardAction', () => {
  beforeEach(() => { inserted.length = 0; });
  it('CARD-01: BCP Visa ····4821 credit with corte, pago and línea saved in the same step', async () => {
    const { createCardAction } = await import('../app/app/actions');
    expect((await createCardAction({}, form({ alias: 'Visa Signature', last4: '4821', kind: 'credit', institution: 'BCP', currency: 'PEN', statementDay: '20', paymentDay: '5', limit: '18000' }))).message).toBe('Tarjeta registrada.');
    expect(inserted[0]).toMatchObject({ user_id: 'u1', kind: 'credit', last4: '4821', statement_day: 20, payment_day: 5, credit_limit_minor: 1800000 });
  });
  it('CARD-02: credit without optional data → nothing invented (no limit, no days)', async () => {
    const { createCardAction } = await import('../app/app/actions');
    await createCardAction({}, form({ alias: 'Visa', last4: '1111', kind: 'credit', currency: 'PEN', statementDay: '', paymentDay: '', limit: '' }));
    expect(inserted[0]).not.toHaveProperty('credit_limit_minor');
    expect(inserted[0]).not.toHaveProperty('statement_day');
  });
  it('CARD-04: a debit card never stores credit data; bad days are refused before writing', async () => {
    const { createCardAction } = await import('../app/app/actions');
    await createCardAction({}, form({ alias: 'Débito', last4: '2222', kind: 'debit', currency: 'USD', statementDay: '20', limit: '500' }));
    expect(inserted[0]).toMatchObject({ kind: 'debit', currency: 'USD' });
    expect(inserted[0]).not.toHaveProperty('credit_limit_minor');
    expect((await createCardAction({}, form({ alias: 'Visa', last4: '3333', kind: 'credit', currency: 'PEN', statementDay: '40' }))).error).toBe('Revisa los días (1 al 31) y la línea.');
    expect(inserted).toHaveLength(1);
  });
  it('CARD-05: a full card number in the alias is refused (never stored)', async () => {
    const { createCardAction } = await import('../app/app/actions');
    expect((await createCardAction({}, form({ alias: '4111 1111 1111 1111', last4: '1111', kind: 'credit', currency: 'PEN' }))).error).toBeTruthy();
    expect(inserted).toHaveLength(0);
  });
});
