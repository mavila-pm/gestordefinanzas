import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSubscriptionForm } from '../src/web/subscription-input';

const get = (o: Record<string, string>) => (k: string) => o[k];

describe('parseSubscriptionForm (untrusted input)', () => {
  it('catalogue service: name from the catalogue, never a price; next date → due day (+ anchor month when not monthly)', () => {
    const r = parseSubscriptionForm(get({ provider: 'netflix', amount: '44.90', currency: 'PEN', frequency: 'monthly', nextDate: '2026-10-15', instrument: '' }), '2026-10-10');
    expect(r).toEqual({ ok: true, value: { name: 'Netflix', provider: 'netflix', currency: 'PEN', amountMinor: 4490, amountStatus: 'confirmed', frequency: 'monthly', dueDay: 15, anchorMonth: null, cardId: null, accountId: null } });
    const y = parseSubscriptionForm(get({ provider: 'paramount-plus', amount: '59.99', currency: 'USD', frequency: 'yearly', nextDate: '2027-03-20' }), '2026-10-10');
    expect(y.ok && y.value).toMatchObject({ frequency: 'yearly', dueDay: 20, anchorMonth: 3, currency: 'USD', amountMinor: 5999 });
  });
  it('SUB-08: no price → unknown (null), never 0', () => {
    const r = parseSubscriptionForm(get({ name: 'Mi gimnasio', amount: '', nextDate: '2026-10-20' }), '2026-10-10');
    expect(r.ok && r.value).toMatchObject({ provider: null, name: 'Mi gimnasio', amountMinor: null, amountStatus: 'unknown' });
  });
  it('rejects junk: unknown slug, bad price, missing/invalid/far date, foreign instrument format', () => {
    const base = { name: 'X', nextDate: '2026-10-20' };
    for (const bad of <Array<Record<string, string>>>[{ provider: 'evil.com' }, { amount: '-5' }, { amount: '0' }, { amount: 'abc' }, { nextDate: '' }, { nextDate: '2026-02-30' }, { nextDate: '2028-01-01' },
      { instrument: 'card:not-a-uuid' }, { instrument: 'wallet:3f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f60' }, { name: '<script>' }, { frequency: 'weekly' }]) {
      expect(parseSubscriptionForm(get({ ...base, ...bad } ), '2026-10-10').ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

// ── saveSubscriptionAction with Supabase stubbed: never a second row for a service already tracked ────────────────
const existing: Array<Record<string, unknown>> = [];
const inserted: Array<Record<string, unknown>> = [];
const query = () => {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'neq']) q[m] = () => q;
  q.limit = async () => ({ data: existing, error: null });
  q.insert = async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; };
  return q;
};
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ from: () => query() }),
  authUser: async () => ({ id: '00000000-0000-4000-8000-00000000000a', email: null }),
}));

describe('saveSubscriptionAction', () => {
  beforeEach(() => { existing.length = 0; inserted.length = 0; vi.useFakeTimers({ now: new Date('2026-10-10T15:00:00Z'), toFake: ['Date'] }); });
  const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); f.set('client_ref', 'ref-123456789'); return f; };

  it('SUB-01: adds Netflix as a subscription obligation (kind, provider, no movement)', async () => {
    const { saveSubscriptionAction } = await import('../app/app/compromisos/suscripciones/actions');
    expect(await saveSubscriptionAction({}, form({ provider: 'netflix', amount: '44.90', currency: 'PEN', frequency: 'monthly', nextDate: '2026-10-15' }))).toEqual({ message: 'Suscripción agregada.' });
    expect(inserted[0]).toMatchObject({ kind: 'subscription', provider: 'netflix', amount_minor: 4490, due_day: 15, paused_until: null, user_id: '00000000-0000-4000-8000-00000000000a' });
  });
  it('first charge later than the projected one → no phantom charge before it', async () => {
    const { saveSubscriptionAction } = await import('../app/app/compromisos/suscripciones/actions');
    await saveSubscriptionAction({}, form({ provider: 'spotify', amount: '20.90', nextDate: '2026-11-15' }));
    expect(inserted[0]).toMatchObject({ due_day: 15, paused_until: '2026-11-15' });
  });
  it('SUB-07: "Netflix" already tracked as a payment or subscription → refused with the way to convert it, nothing inserted', async () => {
    const { saveSubscriptionAction } = await import('../app/app/compromisos/suscripciones/actions');
    existing.push({ id: 'x', name: 'Netflix', kind: 'other', provider: null, currency: 'PEN', ended_on: null });
    expect((await saveSubscriptionAction({}, form({ provider: 'netflix', amount: '44.90', nextDate: '2026-10-15' }))).error).toBe('Ya tienes «Netflix» en tus pagos. Pásalo a suscripciones para no duplicarlo.');
    existing[0]!.kind = 'subscription';
    expect((await saveSubscriptionAction({}, form({ name: 'netflix', nextDate: '2026-10-15' }))).error).toBe('Netflix ya está en tus suscripciones.');
    expect(inserted).toHaveLength(0);
  });
});
