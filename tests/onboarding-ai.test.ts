import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModel, AIRequest } from '../src/ai/model';
import { compactState, mergePatches } from '../src/ai/draft';
import { extractUserMessage } from '../src/ai/prompts';
import { EXTRACT_SCHEMA } from '../src/ai/schema';
import { emptyDraft, type Draft } from '../src/ai/types';

/**
 * onboardingText with Gemini off, failing or answering (ADR-0006, ADR-0020): the real lib/ai.ts door runs with an
 * injected model and an in-memory Supabase. The model's reading is grounded in the message and only completes the
 * rules' reading; without it, a number the rules could not place is asked about, never stored.
 */
const h = vi.hoisted(() => ({ model: null as AIModel | null, requests: [] as AIRequest[], infers: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('../lib/queries', () => ({ loadProfile: async () => ({ displayName: null, givenNames: null, familyNames: null }) }));
vi.mock('../lib/ai', async () => {
  const real = await vi.importActual<typeof import('../lib/ai')>('../lib/ai');
  const { aiConfig } = await vi.importActual<typeof import('../src/ai/config')>('../src/ai/config');
  const rpc = { rpc: async (fn: string) => (fn === 'ai_reserve' ? { data: { call_id: 1 }, error: null } : { data: null, error: null }) };
  return { ...real, infer: (_db: unknown, req: Parameters<typeof real.infer>[1], validate: (t: string) => boolean) => { h.infers++; return real.infer(rpc as never, req, validate, aiConfig({}), h.model); } };
});

type Row = Record<string, unknown>;
const store = { state: null as Row | null, messages: [] as Array<{ role: string; body: string; card: Row | null }> };
function fakeDb() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, order: () => b, limit: () => b, gte: () => b,
      insert: (r: Row) => { if (table === 'conversation_messages') store.messages.push({ role: r.role as string, body: r.body as string, card: (r.card as Row) ?? null }); return b; },
      update: (r: Row) => { if (table === 'onboarding_states' && store.state) store.state = { ...store.state, facts: structuredClone(r.facts) }; return b; },
      maybeSingle: async () => ({ data: table === 'onboarding_states' ? store.state : null, error: null }),
      then: (ok: (x: unknown) => void) => ok({ data: [], error: null }),
    };
    return b;
  };
  return { from } as never;
}
const draft = () => store.state!.facts as Draft;
const lastSaid = () => store.messages.filter((m) => m.role === 'velsuno').at(-1)!;
async function say(text: string) {
  const { onboardingText } = await import('../lib/onboarding');
  await onboardingText(fakeDb(), 'u1', text);
  return lastSaid();
}
/** A model that answers one fixed JSON (what Gemini would return); records each request. */
const answering = (json: unknown): AIModel => ({
  name: 'gemini',
  complete: async (req) => { h.requests.push(req); return { text: JSON.stringify(json), usage: { input: 10, output: 10, cached: 0, image: 0 }, model: req.model, latencyMs: 5 }; },
});

beforeEach(() => {
  // Salary and balance known, the fixed payments question pending: the start of the debts part of the conversation.
  let d: Draft = { ...emptyDraft(), work: 'employee', asked: ['work'] };
  d = mergePatches(d, [{ t: 'income', amountMinor: 450000, day: 30 }, { t: 'balance', amountMinor: 500000 }], null).draft;
  d.pending = 'group:loans';
  d.asked.push('balance', 'income:other', 'group:obligations', 'group:loans');
  d.done.push('incomes', 'obligations');
  store.state = { status: 'active', is_demo: false, facts: d, applied: {}, started_at: null };
  store.messages = [];
  h.model = null; h.requests = []; h.infers = 0;
});

const PARTIAL = 'debo 1200 en la tarjeta bcp y 800 a mi mamá';

describe('without Gemini: a number the rules could not place is asked about, never stored', () => {
  it('"¿A qué corresponde S/ 800?" is the one question; only the card is stored; the answer places the 800', async () => {
    const m = await say(PARTIAL);
    expect(h.infers).toBe(1); // tried, unavailable
    expect(m.body).toMatch(/¿A qué corresponde S\/ 800\?$/);
    expect((m.body.match(/\?/g) ?? []).length).toBe(1);
    expect(m.card).toMatchObject({ question: '¿A qué corresponde S/ 800?', replies: ['Omitir'] });
    expect(draft().pending).toBe('unplaced:80000:PEN');
    expect(draft().debts).toEqual([expect.objectContaining({ kind: 'card', institution: 'BCP', balanceMinor: 120000 })]);
    const { incomes, obligations, debts, variable, balance, accounts } = draft();
    expect(JSON.stringify({ incomes, obligations, debts, variable, balance, accounts })).not.toMatch(/[^\d]80000[^\d]/); // nothing stored for the 800
    const next = await say('se lo debo a mi mamá');
    expect(draft().debts).toEqual([
      expect.objectContaining({ kind: 'card', balanceMinor: 120000 }),
      expect.objectContaining({ kind: 'personal', lender: 'tu mamá', balanceMinor: 80000, balanceStatus: 'confirmed' }),
    ]);
    expect(draft().pending).not.toMatch(/^unplaced:/);
    expect(next.body).not.toContain('¿A qué corresponde');
  });
  it('"Omitir" / "no sé" leaves it out (nothing stored) and the conversation moves on', async () => {
    await say(PARTIAL);
    const m = await say('omitir');
    expect(draft().debts).toHaveLength(1);
    expect(m.body).not.toContain('S/ 800');
    expect(draft().pending).not.toMatch(/^unplaced:/);
  });
  it('a reading with nothing unplaced asks the normal next question', async () => {
    await say('debo en dos tarjetas: bcp 1,200 y bbva 800');
    expect(h.infers).toBe(0); // fully read by the rules: no AI call
    expect(draft().debts.map((x) => [x.institution, x.balanceMinor])).toEqual([['BCP', 120000], ['BBVA', 80000]]);
    expect(draft().pending).not.toMatch(/^unplaced:/);
  });
});

describe('with Gemini: grounded, constrained and merged (the rules\' facts win)', () => {
  it('sends the extraction schema and the same request the bench sends', async () => {
    h.model = answering({ patches: [], bare: null });
    const before = structuredClone(draft());
    await say(PARTIAL);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.schema).toBe(EXTRACT_SCHEMA);
    expect(h.requests[0]!.messages.at(-1)!.content).toBe(extractUserMessage('group:loans', compactState(before), PARTIAL));
  });
  it('an invented amount ("9999") or a bank the person did not name is dropped; unknown stays unknown', async () => {
    h.model = answering({ patches: [
      { t: 'variable', name: 'Gastos básicos', amount: '9999' },
      { t: 'account', institution: 'BBVA', kind: 'bank' },
      { t: 'balance', amount: '9999' },
    ], bare: { amount: '9999' } });
    await say('me quedé misio antes de fin de mes');
    expect(draft().variable).toEqual([expect.objectContaining({ name: 'Gastos básicos', amountMinor: null, amountStatus: 'unknown' })]);
    expect(draft().accounts).toEqual([]);
    expect(draft().balance).toMatchObject({ amountMinor: 500000 });
    expect(JSON.stringify(draft())).not.toContain('999900');
  });
  it('a partial reading is completed, not replaced: a local fact the model omits or contradicts is kept', async () => {
    // The model omits the BCP card and gives it a wrong amount in a second patch; it adds the debt to the mother.
    h.model = answering({ patches: [
      { t: 'debt', kind: 'card', name: 'Tarjeta BCP', institution: 'BCP', balance: '800' },
      { t: 'debt', kind: 'personal', name: 'Deuda con mamá', lender: 'mamá', balance: '800' },
    ], bare: null });
    const m = await say(PARTIAL);
    expect(draft().debts.map((x) => [x.kind, x.institution, x.balanceMinor])).toEqual([['card', 'BCP', 120000], ['personal', null, 80000]]);
    expect(m.body).not.toContain('¿A qué corresponde'); // everything placed
    h.model = answering({ patches: [{ t: 'debt', kind: 'personal', name: 'Deuda con mamá', lender: 'mamá', balance: '800' }], bare: null });
    beforeEachReset();
    await say(PARTIAL);
    expect(draft().debts.map((x) => [x.kind, x.balanceMinor])).toEqual([['card', 120000], ['personal', 80000]]);
  });
  it('a provider failure while reading a partial message keeps what the rules read and asks about the rest', async () => {
    h.model = { name: 'gemini', complete: async () => { throw Object.assign(new Error('x'), { kind: 'http' }); } };
    const m = await say(PARTIAL);
    expect(draft().debts).toHaveLength(1);
    expect(m.body).toMatch(/¿A qué corresponde S\/ 800\?$/);
  });
});

function beforeEachReset() {
  const d = structuredClone(store.state!.facts as Draft);
  d.debts = [];
  d.pending = 'group:loans';
  store.state = { ...store.state!, facts: d };
}
