import { describe, expect, it } from 'vitest';
import {
  abonosByOccurrence, buildPlan, detectVariations, occurrenceState, remainingMinor, suggestMatches,
  type Obligation, type PlanInput, type SettlementRow,
} from '../src/engine/planning';
import { observedAmountsForUnknown, timeline } from '../src/engine/observed';
import { subscriptionTotals, type SubscriptionRow } from '../src/engine/subscriptions';

const ob = (o: Partial<Obligation> & { id: string; name: string }): Obligation => ({
  source: 'obligation', kind: 'other', currency: 'PEN', amountMinor: 10000, amountStatus: 'confirmed', frequency: 'monthly', anchorMonth: null,
  dueDay: 10, dueDayMax: null, targetDay: null, since: '2026-09-20', ...o,
});
// Today 2026-10-01, balance S/ 5,000, salary on the 15th; rent S/ 1,500 due the 5th.
const rent = ob({ id: 'rent', name: 'Alquiler', kind: 'rent', amountMinor: 150000, dueDay: 5 });
const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  currency: 'PEN', today: '2026-10-01', base: { kind: 'balance', amountMinor: 500000, asOf: '2026-10-01T09:00:00-05:00', stale: false },
  obligations: [rent], settledObligations: new Map(),
  incomes: [{ id: 'sal', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null }],
  settledIncomes: new Map(), essentialsMonthlyMinor: 0, cushionMinor: 0, ...o,
});
const abonos = (id: string, period: string, minor: number) => new Map([[id, new Map([[period, minor]])]]);

const row = (status: SettlementRow['status'], amountMinor: number | null = null, period = '2026-10', obligationId = 'rent'): SettlementRow => ({ obligationId, period, status, amountMinor });

describe('occurrence state (ADR-0017): skipped ≠ paid, partial ≠ paid', () => {
  it('no rows → open; a skipped row → skipped (never "Pagado")', () => {
    expect(occurrenceState([], 'rent', '2026-10')).toBe('open');
    expect(occurrenceState([row('skipped')], 'rent', '2026-10')).toBe('skipped');
    expect(occurrenceState([row('skipped')], 'rent', '2026-10', 150000)).not.toBe('paid');
  });

  it('a closing row → paid, whatever the amount (the person said "pago completo")', () => {
    expect(occurrenceState([row('paid', 140000)], 'rent', '2026-10', 150000)).toBe('paid');
    expect(occurrenceState([row('partial', 50000), row('paid', 20000)], 'rent', '2026-10', 150000)).toBe('paid');
  });

  it('partial rows stay partial until the real total reaches a known planned amount', () => {
    expect(occurrenceState([row('partial', 50000)], 'rent', '2026-10', 150000)).toBe('partial');
    expect(occurrenceState([row('partial', 50000), row('partial', 100000)], 'rent', '2026-10', 150000)).toBe('paid');
    // Unknown planned amount: never assumed covered; a row with no readable movement adds nothing.
    expect(occurrenceState([row('partial', 900000)], 'rent', '2026-10', null)).toBe('partial');
    expect(occurrenceState([row('partial', null), row('partial', null)], 'rent', '2026-10', 1)).toBe('partial');
  });

  it('rows of another occurrence or obligation are ignored', () => {
    const rows = [row('paid', 150000, '2026-09'), row('skipped', null, '2026-10', 'net')];
    expect(occurrenceState(rows, 'rent', '2026-10', 150000)).toBe('open');
    expect(occurrenceState(rows, 'net', '2026-10')).toBe('skipped');
  });
});

describe('partial payments in the plan (ADR-0017): planned ≠ paid, remaining = planned − Σ real', () => {
  it('S/ 1,500 rent with a S/ 500 abono: the plan still reserves S/ 1,000 (before: closed, free overstated by S/ 1,000)', () => {
    const p = buildPlan(input({ partialPaid: abonos('rent', '2026-10', 50000) }));
    const l = p.lines.find((x) => x.obligationId === 'rent')!;
    expect(l).toMatchObject({ amountMinor: 100000, paidMinor: 50000, plannedMinor: 150000, period: '2026-10' });
    expect(p.freeMinor).toBe(400000);
    // The old binary path (the occurrence counted as settled) would have said S/ 5,000 free.
    expect(buildPlan(input({ settledObligations: new Map([['rent', new Set(['2026-10'])]]) })).freeMinor).toBe(500000);
  });

  it('500 + 700 → S/ 300 left; abonos reaching the plan → no line, nothing reserved twice', () => {
    expect(buildPlan(input({ partialPaid: abonos('rent', '2026-10', 120000) })).lines.find((x) => x.obligationId === 'rent')?.amountMinor).toBe(30000);
    const covered = buildPlan(input({ partialPaid: abonos('rent', '2026-10', 150000) }));
    expect(covered.lines.some((x) => x.obligationId === 'rent')).toBe(false);
    expect(covered.freeMinor).toBe(500000);
    expect(remainingMinor(150000, 200000)).toBe(0);
  });

  it('unknown price + abono: still unknown (never 0, never the abono), and the missing item says what was paid', () => {
    const net = ob({ id: 'net', name: 'Internet', amountMinor: null, amountStatus: 'unknown', dueDay: 8 });
    const p = buildPlan(input({ obligations: [net], partialPaid: abonos('net', '2026-10', 5000) }));
    expect(p.lines.find((x) => x.obligationId === 'net')).toMatchObject({ amountMinor: null, paidMinor: 5000, plannedMinor: null });
    expect(p.missing.find((m) => m.code === 'amount')?.text).toBe('Falta el monto de Internet: ya pagaste S/ 50.00.');
    expect(p.status).toBe('partial');
    expect(remainingMinor(null, 5000)).toBeNull();
  });

  it('an overdue occurrence with an abono keeps only what is left, and says so', () => {
    const p = buildPlan(input({ today: '2026-10-08', base: { kind: 'balance', amountMinor: 500000, asOf: '2026-10-08T09:00:00-05:00', stale: false }, partialPaid: abonos('rent', '2026-10', 50000) }));
    expect(p.lines.find((x) => x.obligationId === 'rent')).toMatchObject({ kind: 'overdue', amountMinor: 100000, note: 'Ya venció y falta completar el pago' });
  });

  it('PEN ≠ USD: a USD payment and its abonos never reach the PEN plan', () => {
    const usd = ob({ id: 'usd', name: 'Hosting', currency: 'USD', amountMinor: 2000, dueDay: 6 });
    const p = buildPlan(input({ obligations: [rent, usd], partialPaid: new Map([['usd', new Map([['2026-10', 1000]])]]) }));
    expect(p.lines.map((x) => x.obligationId)).toEqual(['rent']);
    expect(p.lines[0]!.amountMinor).toBe(150000);
    // The loader's aggregation drops a movement in another currency, an unconfirmed one, and closed occurrences.
    const currencyOf = new Map([['rent', 'PEN' as const], ['usd', 'USD' as const]]);
    const rows = [
      { obligationId: 'rent', period: '2026-10', status: 'partial' as const, amountMinor: 50000, currency: 'PEN' as const, txConfirmed: true },
      { obligationId: 'rent', period: '2026-10', status: 'partial' as const, amountMinor: 30000, currency: 'USD' as const, txConfirmed: true },
      { obligationId: 'rent', period: '2026-10', status: 'partial' as const, amountMinor: 20000, currency: 'PEN' as const, txConfirmed: false },
      { obligationId: 'rent', period: '2026-09', status: 'partial' as const, amountMinor: 50000, currency: 'PEN' as const, txConfirmed: true },
      { obligationId: 'rent', period: '2026-09', status: 'paid' as const, amountMinor: 100000, currency: 'PEN' as const, txConfirmed: true },
      { obligationId: 'usd', period: '2026-10', status: 'partial' as const, amountMinor: 700, currency: 'USD' as const, txConfirmed: true },
    ];
    expect(abonosByOccurrence(rows, currencyOf)).toEqual(new Map([['rent', new Map([['2026-10', 50000]])], ['usd', new Map([['2026-10', 700]])]]));
  });

  it('variations: an abono is not a price drop; a closed month compares its REAL total', () => {
    const r = ob({ id: 'rent', name: 'Alquiler', amountMinor: 150000 });
    expect(detectVariations([r], [{ obligationId: 'rent', period: '2026-10', actualMinor: 50000, acknowledged: false, status: 'partial' }])).toEqual([]);
    expect(detectVariations([r], [
      { obligationId: 'rent', period: '2026-10', actualMinor: 50000, acknowledged: false, status: 'partial' },
      { obligationId: 'rent', period: '2026-10', actualMinor: 100000, acknowledged: false, status: 'paid' },
    ])).toEqual([]);
    expect(detectVariations([r], [
      { obligationId: 'rent', period: '2026-10', actualMinor: 50000, acknowledged: false, status: 'partial' },
      { obligationId: 'rent', period: '2026-10', actualMinor: 110000, acknowledged: false, status: 'paid' },
    ])[0]).toMatchObject({ actualMinor: 160000, deltaMinor: 10000 });
    // The newest CLOSED month is the reference: an open month after it is ignored.
    expect(detectVariations([r], [
      { obligationId: 'rent', period: '2026-09', actualMinor: 150000, acknowledged: false },
      { obligationId: 'rent', period: '2026-10', actualMinor: 20000, acknowledged: false, status: 'partial' },
    ])).toEqual([]);
  });

  it('observed amount for an unknown price: only a closed month, summing its abonos', () => {
    const net = ob({ id: 'net', name: 'Internet', amountMinor: null, amountStatus: 'unknown' });
    expect(observedAmountsForUnknown([net], [{ obligationId: 'net', period: '2026-10', actualMinor: 5000, status: 'partial' }])).toEqual([]);
    expect(observedAmountsForUnknown([net], [
      { obligationId: 'net', period: '2026-10', actualMinor: 5000, status: 'partial' }, { obligationId: 'net', period: '2026-10', actualMinor: 3900, status: 'paid' },
    ])).toEqual([{ obligationId: 'net', name: 'Internet', currency: 'PEN', observedMinor: 8900, period: '2026-10' }]);
  });

  it('suggestions: the rest after an abono matches; a smaller movement with the same name is offered as a possible abono', () => {
    const r = ob({ id: 'rent', name: 'Alquiler', amountMinor: 150000, dueDay: 5 });
    const t = (id: string, amountMinor: number, merchant: string | null) => ({ id, occurredOn: '2026-10-04', amountMinor, currency: 'PEN' as const, merchant });
    const none = new Map<string, Set<string>>();
    expect(suggestMatches([r], [t('a', 50000, 'TRANSF ALQUILER OCT')], none, new Set())).toEqual([
      { obligationId: 'rent', name: 'Alquiler', period: '2026-10', transactionId: 'a', confidence: 'medium', amountMinor: 50000, remainingMinor: 150000, partial: true }]);
    expect(suggestMatches([r], [t('a', 50000, 'WONG')], none, new Set())).toEqual([]); // no name, other amount: never guessed
    expect(suggestMatches([r], [t('b', 100000, 'YAPE')], none, new Set(['a']), abonos('rent', '2026-10', 50000))).toEqual([
      { obligationId: 'rent', name: 'Alquiler', period: '2026-10', transactionId: 'b', confidence: 'medium', amountMinor: 100000, remainingMinor: 100000, partial: false }]);
    expect(suggestMatches([r], [t('c', 100000, 'ALQUILER')], none, new Set(), abonos('rent', '2026-10', 150000))).toEqual([]); // already covered
    // A USD movement never suggests a PEN payment.
    expect(suggestMatches([r], [{ ...t('d', 150000, 'ALQUILER'), currency: 'USD' }], none, new Set())).toEqual([]);
  });

  it('timeline shows what remains and the real abono; a covered occurrence disappears', () => {
    const base = { today: '2026-10-01', obligations: [rent], incomes: [], settledObligations: new Map(), settledIncomes: new Map() };
    expect(timeline({ ...base, partialPaid: abonos('rent', '2026-10', 50000) }, 10)[0]).toMatchObject({ label: 'Alquiler', amountMinor: 100000, paidMinor: 50000 });
    expect(timeline({ ...base, partialPaid: abonos('rent', '2026-10', 150000) }, 10)).toEqual([]);
  });

  it('subscriptions: an abono counts as paid this month (real money); the period stays open for the next charge', () => {
    const sub: SubscriptionRow = { ...ob({ id: 's', name: 'Netflix', kind: 'subscription', amountMinor: 4490, dueDay: 3 }), active: true, provider: 'netflix', cardId: null, accountId: null };
    const fact = (status: 'paid' | 'partial' | 'skipped', amountMinor: number | null) => ({ obligationId: 's', period: '2026-10', status, transactionId: 't', amountMinor, occurredOn: '2026-10-03', currency: 'PEN' as const, merchant: null });
    expect(subscriptionTotals([sub], [fact('partial', 2000)], '2026-10-01')[0]).toMatchObject({ paidMonthMinor: 2000, paidMonthCount: 1, next30Count: 1 });
    expect(subscriptionTotals([sub], [fact('skipped', null)], '2026-10-01')[0]).toMatchObject({ paidMonthMinor: 0, next30Count: 0 });
  });
});
