import { describe, expect, it } from 'vitest';
import { matchProvider, monogram, providerBySlug, searchProviders } from '../src/domain/subscriptions';
import { monthlyEquivalentMinor, nextCharge, startPause, paymentHistory, subscriptionState, subscriptionTotals, type SettlementFact, type SubscriptionRow } from '../src/engine/subscriptions';

const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({
  id: 'netflix', source: 'obligation', name: 'Netflix', kind: 'subscription', currency: 'PEN', amountMinor: 4490, amountStatus: 'confirmed',
  frequency: 'monthly', anchorMonth: null, dueDay: 15, dueDayMax: null, targetDay: null, since: '2026-01-01', active: true,
  provider: 'netflix', cardId: null, accountId: null, pausedUntil: null, endedOn: null, ...o,
});
const paid = (o: Partial<SettlementFact>): SettlementFact => ({
  obligationId: 'netflix', period: '2026-10', status: 'paid', transactionId: 't1', amountMinor: 4490, occurredOn: '2026-10-15', currency: 'PEN', merchant: 'NETFLIX.COM', ...o,
});

describe('catalogue', () => {
  it('recognises services by name or alias, whole words, longest alias first', () => {
    expect(matchProvider('Netflix')?.slug).toBe('netflix');
    expect(matchProvider('pago HBO MAX octubre')?.slug).toBe('max');
    expect(matchProvider('Disney Plus')?.slug).toBe('disney-plus');
    expect(matchProvider('Paramount+')?.slug).toBe('paramount-plus');
    expect(matchProvider('disney+ anual')?.slug).toBe('disney-plus');
    expect(matchProvider('Apple Music familiar')?.slug).toBe('apple-music');
    expect(matchProvider('Maximo gimnasio')).toBeNull(); // "max" must be a whole word
    expect(matchProvider('Mi gimnasio')).toBeNull();
    expect(searchProviders('para').map((p) => p.slug)).toEqual(['paramount-plus']);
    expect(searchProviders('').length).toBeGreaterThan(10);
    expect(providerBySlug('nope')).toBeNull();
    expect(monogram('Mi gimnasio')).toBe('MG');
    expect(monogram('Gym')).toBe('GY');
  });
});

describe('Mis suscripciones engine', () => {
  it('a first charge set later than the next projected one suspends planning until it (no phantom charge)', () => {
    const base = { frequency: 'monthly' as const, anchorMonth: null, dueDay: 15, dueDayMax: null, targetDay: null };
    expect(startPause(base, '2026-10-10', '2026-11-15')).toBe('2026-11-15');
    expect(startPause(base, '2026-10-10', '2026-10-15')).toBeNull();
    expect(startPause({ ...base, frequency: 'yearly', anchorMonth: 3 }, '2026-10-10', '2027-03-15')).toBeNull();
    const s = sub({ pausedUntil: '2026-11-15', since: '2026-10-10' });
    expect(nextCharge(s, '2026-10-10', new Set())).toMatchObject({ date: '2026-11-15' });
  });

  it('SUB-01: monthly Netflix S/ 44.90 on the 15th → next charge 15/10, in the 30-day total', () => {
    const s = sub({});
    expect(nextCharge(s, '2026-10-10', new Set())).toEqual({ period: '2026-10', date: '2026-10-15', amountMinor: 4490, estimated: false, overdue: false });
    const [pen] = subscriptionTotals([s], [], '2026-10-10');
    expect(pen).toMatchObject({ currency: 'PEN', active: 1, next30Minor: 4490, next30Count: 1, monthlyMinor: 4490, paidMonthMinor: 0 });
  });

  it('SUB-02: yearly Paramount+ US$ 59.99 → monthly equivalent is analytical; projected whole, only on its real date', () => {
    const s = sub({ id: 'pp', name: 'Paramount+', provider: 'paramount-plus', currency: 'USD', amountMinor: 5999, frequency: 'yearly', anchorMonth: 3, dueDay: 20 });
    expect(monthlyEquivalentMinor(s)).toBe(500);
    expect(nextCharge(s, '2026-10-10', new Set())).toMatchObject({ date: '2027-03-20', amountMinor: 5999 });
    const [usd] = subscriptionTotals([s], [], '2026-10-10');
    expect(usd).toMatchObject({ currency: 'USD', monthlyMinor: 500, next30Minor: 0, next30Count: 0 });
    // In the 30 days before March 20 the whole US$ 59.99 is due, once.
    expect(subscriptionTotals([s], [], '2027-03-01')[0]).toMatchObject({ next30Minor: 5999, next30Count: 1 });
  });

  it('SUB-03: a linked confirmed payment settles the period once and counts once in "pagado este mes"', () => {
    const s = sub({});
    const settled = [paid({})];
    expect(nextCharge(s, '2026-10-16', new Set(['2026-10']))).toMatchObject({ date: '2026-11-15' });
    const [pen] = subscriptionTotals([s], settled, '2026-10-16');
    expect(pen).toMatchObject({ paidMonthMinor: 4490, paidMonthCount: 1, next30Minor: 4490, next30Count: 1 });
    expect(paymentHistory('netflix', settled)).toHaveLength(1);
  });

  it('SUB-05: a new price changes only what comes; the history keeps what was really paid', () => {
    const history = [paid({ period: '2026-09', amountMinor: 4490, occurredOn: '2026-09-15' }), paid({ period: '2026-10', amountMinor: 4490 })];
    const s = sub({ amountMinor: 4990 });
    expect(nextCharge(s, '2026-10-20', new Set(['2026-09', '2026-10']))).toMatchObject({ date: '2026-11-15', amountMinor: 4990 });
    expect(paymentHistory('netflix', history).map((h) => [h.period, h.amountMinor])).toEqual([['2026-10', 4490], ['2026-09', 4490]]);
  });

  it('SUB-06: paused or ended → no future charges and out of the totals; history untouched', () => {
    const ended = sub({ endedOn: '2026-10-10' });
    expect(subscriptionState(ended, '2026-10-12')).toBe('ended');
    expect(nextCharge(ended, '2026-10-12', new Set())).toBeNull();
    const paused = sub({ pausedUntil: '2026-12-01' });
    expect(subscriptionState(paused, '2026-10-12')).toBe('paused');
    expect(nextCharge(paused, '2026-10-12', new Set())).toMatchObject({ date: '2026-12-15' });
    expect(subscriptionTotals([paused], [], '2026-10-12')[0]).toMatchObject({ active: 1, next30Count: 0, monthlyMinor: 4490 });
    expect(subscriptionTotals([ended], [], '2026-10-12')).toEqual([]);
    expect(paymentHistory('netflix', [paid({})])).toHaveLength(1);
  });

  it('SUB-08: unknown price → "por confirmar", counted apart, never S/ 0', () => {
    const s = sub({ amountMinor: null, amountStatus: 'unknown' });
    expect(subscriptionState(s, '2026-10-10')).toBe('pending');
    expect(monthlyEquivalentMinor(s)).toBeNull();
    expect(nextCharge(s, '2026-10-10', new Set())).toMatchObject({ amountMinor: null });
    expect(subscriptionTotals([s], [], '2026-10-10')[0]).toMatchObject({ monthlyMinor: 0, monthlyUnknown: 1, next30Minor: 0, next30Unknown: 1 });
  });

  it('SUB-10: day 31 clamps to the last day (Feb in a leap year), across the year end; a charge unpaid for ≤ 7 days shows first', () => {
    const s = sub({ dueDay: 31 });
    expect(nextCharge(s, '2028-02-10', new Set())).toMatchObject({ date: '2028-02-29' });
    expect(nextCharge(s, '2027-02-10', new Set())).toMatchObject({ date: '2027-02-28' });
    expect(nextCharge(sub({ dueDay: 5 }), '2026-12-20', new Set(['2026-12']))).toMatchObject({ date: '2027-01-05' });
    expect(nextCharge(sub({ dueDay: 5 }), '2026-10-10', new Set())).toMatchObject({ date: '2026-10-05', overdue: true });
    expect(nextCharge(sub({ dueDay: 1 }), '2026-10-10', new Set())).toMatchObject({ date: '2026-11-01', overdue: false }); // > 7 days ago: not chased
  });

  it('PEN and USD never mix; only own subscriptions count in "pagado"', () => {
    const totals = subscriptionTotals([sub({}), sub({ id: 'sp', currency: 'USD', amountMinor: 1099, provider: 'spotify' })],
      [paid({}), paid({ obligationId: 'other', amountMinor: 99999 })], '2026-10-20');
    expect(totals.map((x) => [x.currency, x.monthlyMinor, x.paidMonthMinor])).toEqual([['PEN', 4490, 4490], ['USD', 1099, 0]]);
  });
});

import { answer, detectIntent, type View } from '../src/ai/vels-answers';
describe('Vels on subscriptions (engine answers, 0 AI quota)', () => {
  const v = { today: '2026-10-10', plans: [], obligations: [], debts: [], reviewCount: 0, suggestions: [],
    subscriptions: [
      { id: 'n1', name: 'Netflix', currency: 'PEN', amountMinor: 4490, monthlyMinor: 4490, nextDate: '2026-10-15', paidYearMinor: 40410, paidYearCount: 9 },
      { id: 'p1', name: 'Paramount+', currency: 'USD', amountMinor: 5999, monthlyMinor: 500, nextDate: '2027-03-20', paidYearMinor: 0, paidYearCount: 0 },
      { id: 'g1', name: 'Gimnasio', currency: 'PEN', amountMinor: null, monthlyMinor: null, nextDate: null, paidYearMinor: 0, paidYearCount: 0 },
    ] } as unknown as View;
  it('detects the questions', () => {
    expect(detectIntent('¿Cuánto gasto en suscripciones?')).toEqual({ k: 'subs_total' });
    expect(detectIntent('¿Cuánto pagué por Netflix este año?')).toEqual({ k: 'subs_paid', name: 'Netflix' });
    expect(detectIntent('Pausa mi suscripción a Paramount+')).toEqual({ k: 'subs_pause', name: 'Paramount+' });
    expect(detectIntent('ya pagué netflix').k).toBe('paid');
  });
  it('answers with real numbers per currency, never mixes PEN/USD, and never claims to cancel the service', () => {
    const total = answer({ k: 'subs_total' }, v)!;
    expect(total.text).toBe('Tienes 3 suscripciones: unos S/ 44.90 y US$ 5 al mes (estimado). A 1 le falta el precio.');
    expect(answer({ k: 'subs_paid', name: 'Netflix' }, v)!.text).toBe('Este año pagaste S/ 404.10 por Netflix (9 cobros confirmados).');
    expect(answer({ k: 'subs_paid', name: 'Paramount+' }, v)!.text).toBe('Todavía no tengo cobros de Paramount+ confirmados este año.');
    const pause = answer({ k: 'subs_pause', name: 'Paramount+' }, v)!;
    expect(pause.text).toContain('Esto no cancela tu suscripción en Paramount+');
    expect(pause.actions?.[0]).toMatchObject({ href: '/app/compromisos/suscripciones?id=p1' });
  });
});
