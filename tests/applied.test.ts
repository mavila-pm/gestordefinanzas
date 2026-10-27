import { describe, expect, it } from 'vitest';
import { linesToApply, reconcile, sameAsSeen, validAppliedLines, type AppliedPlan } from '../src/engine/applied';
import { buildPlan, type PlanInput } from '../src/engine/planning';

const O = '00000000-0000-4000-8000-000000000001';
const input: PlanInput = {
  currency: 'PEN', today: '2026-09-29', base: { kind: 'balance', amountMinor: 500000, asOf: '2026-09-29T10:00:00Z', stale: false },
  obligations: [
    { id: O, source: 'obligation', name: 'Alquiler', kind: 'rent', currency: 'PEN', amountMinor: 150000, amountStatus: 'confirmed', frequency: 'monthly', anchorMonth: null, dueDay: 5, dueDayMax: null, targetDay: null, since: '2026-09-20' },
    { id: '00000000-0000-4000-8000-000000000002', source: 'obligation', name: 'Internet', kind: 'internet', currency: 'PEN', amountMinor: null, amountStatus: 'unknown', frequency: 'monthly', anchorMonth: null, dueDay: 8, dueDayMax: null, targetDay: null, since: '2026-09-20' },
  ],
  settledObligations: new Map(), incomes: [{ id: 'i', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null }],
  settledIncomes: new Map(), essentialsMonthlyMinor: 60000, cushionMinor: 20000,
};

function applied(): AppliedPlan {
  const p = buildPlan(input);
  return { id: 'x', currency: 'PEN', status: 'active', baseKind: 'balance', baseMinor: 500000, fromDate: p.from, untilDate: p.until!, reservedMinor: p.reservedMinor, freeMinor: p.freeMinor!, planStatus: 'partial', lines: linesToApply(p), createdAt: '2026-09-29T15:00:00Z', closedAt: null };
}

describe('applied plan (ADR-0013)', () => {
  it('keeps committed, reserved, unknown and realized apart; unknown is never 0', () => {
    const a = applied();
    const r = reconcile(a, '2026-09-29', { paid: new Map() });
    expect(r.committedMinor).toBe(150000);
    expect(r.realizedMinor).toBe(0);
    expect(r.unknownCount).toBe(1);
    expect(r.reservedMinor).toBe(a.reservedMinor - 150000);
    expect(r.lines.find((l) => l.label === 'Alquiler')?.period).toBe('2026-10');
  });

  it('a line is realized only by a real settlement of the same obligation and period', () => {
    const a = applied();
    expect(reconcile(a, '2026-09-29', { paid: new Map([[O, new Set(['2026-09'])]]) }).realizedMinor).toBe(0);
    const r = reconcile(a, '2026-10-06', { paid: new Map([[O, new Set(['2026-10'])]]), paidMinor: new Map([[O, new Map([['2026-10', 150000]])]]) });
    expect(r.realizedMinor).toBe(150000);
    expect(r.committedMinor).toBe(0);
    expect(r.lines.find((l) => l.label === 'Alquiler')?.state).toBe('realized');
  });

  it('realizado is the REAL amount, never the planned one; skipped is neither realized nor pending (ADR-0017)', () => {
    const a = applied();
    const paid = { paid: new Map([[O, new Set(['2026-10'])]]) };
    // Closed with a smaller real payment ("pago completo" of S/ 1,400): realized 1,400, not 1,500.
    expect(reconcile(a, '2026-10-06', { ...paid, paidMinor: new Map([[O, new Map([['2026-10', 140000]])]]) }).realizedMinor).toBe(140000);
    // Closed but the movement cannot be read: unknown, never the planned amount.
    const unread = reconcile(a, '2026-10-06', paid);
    expect(unread.realizedMinor).toBe(0);
    expect(unread.unknownCount).toBe(2);
    const skipped = reconcile(a, '2026-10-06', { paid: new Map(), skipped: new Map([[O, new Set(['2026-10'])]]) });
    expect(skipped.lines.find((l) => l.label === 'Alquiler')?.state).toBe('skipped');
    expect(skipped.realizedMinor + skipped.committedMinor).toBe(0);
  });

  it('an abono after applying: realized = the abono, committed = what is left', () => {
    const r = reconcile(applied(), '2026-10-01', { paid: new Map(), paidMinor: new Map([[O, new Map([['2026-10', 50000]])]]) });
    expect(r.realizedMinor).toBe(50000);
    expect(r.committedMinor).toBe(100000);
    // An abono made before applying was already left out of the line: it does not lower it twice.
    const before = applied();
    before.lines = before.lines.map((l) => (l.label === 'Alquiler' ? { ...l, amountMinor: 100000, paidMinor: 50000 } : l));
    const r2 = reconcile(before, '2026-10-01', { paid: new Map(), paidMinor: new Map([[O, new Map([['2026-10', 70000]])]]) });
    expect(r2.committedMinor).toBe(80000);
    expect(r2.realizedMinor).toBe(70000);
  });

  it('unpaid past its date → late; horizon passed → expired', () => {
    const r = reconcile(applied(), '2026-10-20', { paid: new Map() });
    expect(r.lines.find((l) => l.label === 'Alquiler')?.state).toBe('late');
    expect(r.expired).toBe(true);
  });

  it('stale tab: applies only the plan that was seen', () => {
    const p = buildPlan(input);
    expect(sameAsSeen(p, p.freeMinor, p.reservedMinor)).toBe(true);
    expect(sameAsSeen(p, p.freeMinor! + 100, p.reservedMinor)).toBe(false);
    expect(sameAsSeen(p, null, null)).toBe(false);
  });

  it('stored lines are re-validated: bad kinds, negative or fractional amounts and bad ids are dropped', () => {
    expect(validAppliedLines([
      { kind: 'payment', label: 'Ok', amountMinor: 100, date: '2026-10-05', obligationId: O, period: '2026-10' },
      { kind: 'transfer', label: 'X', amountMinor: 100 }, { kind: 'payment', label: 'N', amountMinor: -5 },
      { kind: 'payment', label: 'F', amountMinor: 1.5 }, { kind: 'payment', label: 'I', amountMinor: null, obligationId: 'drop table', period: 'x' },
    ])).toEqual([
      { kind: 'payment', label: 'Ok', amountMinor: 100, date: '2026-10-05', obligationId: O, period: '2026-10' },
      { kind: 'payment', label: 'I', amountMinor: null, date: null, obligationId: null, period: null },
    ]);
    expect(validAppliedLines('nope')).toEqual([]);
  });
});
