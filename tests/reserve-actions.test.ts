import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReserveEntryForm, parseReserveForm } from '../src/web/planning-input';
import { reserveMoveText, toReserves } from '../lib/reserves';

/** Apartados write path (ADR-0017): parsing on the server, the shared move path, and the actions with Supabase stubbed. */
let reserve: Record<string, unknown> | null = null;
let savedSeq: number[] = [];
let insertError: { code: string; message: string; details?: string } | null = null;
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
const updates: Array<Record<string, unknown>> = [];
let updateResult: { data: unknown[] | null; error: { code: string } | null } = { data: [{ id: 'r1' }], error: null };
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../lib/learning', () => ({ logLearning: vi.fn(), decide: vi.fn() }));
vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit', 'order']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === 'reserves' ? reserve : { saved_minor: savedSeq.length > 1 ? savedSeq.shift() : savedSeq[0] }, error: null });
      q.insert = async (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: insertError }; };
      q.update = (row: Record<string, unknown>) => {
        updates.push(row);
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.select = async () => updateResult;
        return chain;
      };
      return q;
    },
  }),
  authUser: async () => ({ id: 'u1', email: null }),
}));
const UUID = '3f1c0b5e-6c8e-4a43-9d2a-1b2c3d4e5f60';
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const get = (o: Record<string, string>) => (k: string) => o[k];

describe('parseReserveForm / parseReserveEntryForm (untrusted input)', () => {
  it('name, currency, optional target and date; a date needs a target and is not in the past', () => {
    expect(parseReserveForm(get({ name: '  Viaje   a Cusco ', currency: 'PEN', target: '1,200', targetDate: '2026-12-20' }), '2026-10-22'))
      .toEqual({ ok: true, value: { name: 'Viaje a Cusco', currency: 'PEN', targetMinor: 120000, targetDate: '2026-12-20' } });
    expect(parseReserveForm(get({ name: 'Fondo', currency: 'USD' }), '2026-10-22')).toEqual({ ok: true, value: { name: 'Fondo', currency: 'USD', targetMinor: null, targetDate: null } });
    expect(parseReserveForm(get({ name: '', currency: 'PEN' }), '2026-10-22')).toMatchObject({ ok: false });
    expect(parseReserveForm(get({ name: 'x'.repeat(41) }), '2026-10-22')).toMatchObject({ ok: false });
    expect(parseReserveForm(get({ name: '<b>', currency: 'PEN' }), '2026-10-22')).toMatchObject({ ok: false });
    expect(parseReserveForm(get({ name: 'Viaje', currency: 'EUR' }), '2026-10-22')).toEqual({ ok: false, error: 'Elige soles o dólares.' });
    expect(parseReserveForm(get({ name: 'Viaje', target: '0' }), '2026-10-22')).toMatchObject({ ok: false });
    expect(parseReserveForm(get({ name: 'Viaje', targetDate: '2026-12-20' }), '2026-10-22')).toEqual({ ok: false, error: 'Para poner una fecha, indica cuánto quieres juntar.' });
    expect(parseReserveForm(get({ name: 'Viaje', target: '500', targetDate: '2026-10-01' }), '2026-10-22')).toEqual({ ok: false, error: 'La fecha debe ser hoy o después.' });
    expect(parseReserveForm(get({ name: 'Viaje', target: '500', targetDate: '2026-10-01' }), null)).toMatchObject({ ok: true }); // editing keeps a passed date
    expect(parseReserveForm(get({ name: 'Viaje', target: '500', targetDate: '2026-02-30' }), null)).toEqual({ ok: false, error: 'Revisa la fecha.' });
  });
  it('an entry is an id, in/out and a positive amount (parsed here, never trusted from the client)', () => {
    expect(parseReserveEntryForm(get({ reserveId: UUID, direction: 'in', amount: '200' }))).toEqual({ ok: true, value: { reserveId: UUID, direction: 'in', amountMinor: 20000 } });
    expect(parseReserveEntryForm(get({ reserveId: UUID, direction: 'out', amount: '-5' }))).toMatchObject({ ok: false });
    expect(parseReserveEntryForm(get({ reserveId: UUID, direction: 'sideways', amount: '5' }))).toMatchObject({ ok: false });
    expect(parseReserveEntryForm(get({ reserveId: 'r1', direction: 'in', amount: '5' }))).toMatchObject({ ok: false });
  });
});

describe('toReserves / reserveMoveText (pure)', () => {
  it('joins saved amounts (0 when no entries) and drops anything that is not PEN or USD', () => {
    expect(toReserves([{ id: 'a', name: 'Viaje', currency: 'PEN', target_minor: '120000', target_date: '2026-12-20' }, { id: 'b', name: 'X', currency: 'EUR', target_minor: null, target_date: null },
      { id: 'c', name: 'Fondo', currency: 'USD', target_minor: null, target_date: null }], [{ reserve_id: 'a', saved_minor: '30000' }]))
      .toEqual([{ id: 'a', name: 'Viaje', currency: 'PEN', savedMinor: 30000, targetMinor: 120000, targetDate: '2026-12-20' },
        { id: 'c', name: 'Fondo', currency: 'USD', savedMinor: 0, targetMinor: null, targetDate: null }]);
  });
  it('copy says the amount, the currency and what is left', () => {
    expect(reserveMoveText({ ok: true, name: 'Viaje', currency: 'PEN', savedMinor: 50000 }, 'in', 20000)).toEqual({ message: 'Apartaste S/ 200.00 para Viaje. Llevas S/ 500.00.' });
    expect(reserveMoveText({ ok: true, name: 'Viaje', currency: 'USD', savedMinor: 0 }, 'out', 5000)).toEqual({ message: 'Usaste US$ 50.00 de Viaje. Quedan US$ 0.00.' });
    expect(reserveMoveText({ ok: false, error: 'insufficient', name: 'Viaje', currency: 'PEN', savedMinor: 30000 }, 'out', 40000)).toEqual({ error: 'Solo tienes S/ 300.00 apartados en Viaje.' });
  });
});

describe('reserveEntryAction / saveReserveAction / archiveReserveAction', () => {
  beforeEach(() => {
    inserts.length = 0; updates.length = 0; insertError = null; savedSeq = [30000];
    reserve = { name: 'Viaje', currency: 'PEN', active: true };
    updateResult = { data: [{ id: 'r1' }], error: null };
  });

  it('"Apartar S/ 200": one entry with the server-parsed amount; never a transaction', async () => {
    const { reserveEntryAction } = await import('../app/app/plan/actions');
    savedSeq = [30000, 50000];
    expect((await reserveEntryAction({}, form({ reserveId: UUID, direction: 'in', amount: '200', client_ref: 'ref-apartar-0001' }))).message).toBe('Apartaste S/ 200.00 para Viaje. Llevas S/ 500.00.');
    expect(inserts).toEqual([{ table: 'reserve_entries', row: { user_id: 'u1', reserve_id: UUID, direction: 'in', amount_minor: 20000, client_ref: 'ref-apartar-0001' } }]);
  });

  it('"Usar" more than saved is refused before writing, with what there is', async () => {
    const { reserveEntryAction } = await import('../app/app/plan/actions');
    expect((await reserveEntryAction({}, form({ reserveId: UUID, direction: 'out', amount: '400' }))).error).toBe('Solo tienes S/ 300.00 apartados en Viaje.');
    expect(inserts).toHaveLength(0);
  });

  it('another tab took money out meanwhile: the SQL guard refuses (23514) and the person sees the new amount', async () => {
    const { reserveEntryAction } = await import('../app/app/plan/actions');
    savedSeq = [30000, 10000];
    insertError = { code: '23514', message: 'reserve_insufficient' };
    expect((await reserveEntryAction({}, form({ reserveId: UUID, direction: 'out', amount: '250' }))).error).toBe('Solo tienes S/ 100.00 apartados en Viaje.');
  });

  it('a double submit (same client_ref) answers success without a second row', async () => {
    const { reserveEntryAction } = await import('../app/app/plan/actions');
    insertError = { code: '23505', message: 'duplicate key value violates unique constraint "reserve_entries_client_ref"' };
    expect((await reserveEntryAction({}, form({ reserveId: UUID, direction: 'in', amount: '50', client_ref: 'ref-apartar-0002' }))).message).toMatch(/^Apartaste S\/ 50.00 para Viaje/);
  });

  it('an archived apartado takes nothing', async () => {
    const { reserveEntryAction } = await import('../app/app/plan/actions');
    reserve = { name: 'Viaje', currency: 'PEN', active: false };
    expect((await reserveEntryAction({}, form({ reserveId: UUID, direction: 'in', amount: '50' }))).error).toBe('Ese apartado está archivado.');
    expect(inserts).toHaveLength(0);
  });

  it('create: name, currency, target, date and client_ref; same active name → clear error', async () => {
    const { saveReserveAction } = await import('../app/app/plan/actions');
    expect((await saveReserveAction({}, form({ name: 'Viaje', currency: 'PEN', target: '1200', targetDate: '2099-12-20', client_ref: 'ref-reserve-0001' }))).message).toBe('Listo, creaste el apartado Viaje.');
    expect(inserts[0]).toEqual({ table: 'reserves', row: { user_id: 'u1', name: 'Viaje', currency: 'PEN', target_minor: 120000, target_date: '2099-12-20', client_ref: 'ref-reserve-0001' } });
    insertError = { code: '23505', message: 'duplicate key value violates unique constraint "reserves_active_name"' };
    expect((await saveReserveAction({}, form({ name: 'viaje', currency: 'PEN' }))).error).toBe('Ya tienes un apartado con ese nombre en esa moneda.');
  });

  it('edit never sends the currency; archive with money is refused by the guard', async () => {
    const { saveReserveAction, archiveReserveAction } = await import('../app/app/plan/actions');
    expect((await saveReserveAction({}, form({ id: UUID, name: 'Viaje a Cusco', currency: 'USD', target: '1500' }))).message).toBe('Apartado actualizado.');
    expect(updates[0]).not.toHaveProperty('currency');
    expect(updates[0]).toMatchObject({ name: 'Viaje a Cusco', target_minor: 150000, target_date: null });
    updateResult = { data: null, error: { code: '23514' } };
    expect((await archiveReserveAction({}, form({ id: UUID }))).error).toBe('Todavía tiene dinero apartado. Úsalo primero y luego archívalo.');
  });
});
