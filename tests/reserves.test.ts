import { describe, expect, it } from 'vitest';
import {
  buildPlan, INFREQUENT_RESERVE_RULE, planBreakdown, reserveContribution, reserveOverlaps, reserveProgress, setAsideSince,
  type Obligation, type PlanInput, type Reserve,
} from '../src/engine/planning';
import { validAppliedLines } from '../src/engine/applied';

/** Apartados in the engine (ADR-0017): saved money is not free money; a dated target plans a contribution. */
const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  currency: 'PEN', today: '2026-10-01', base: { kind: 'balance', amountMinor: 500000, asOf: '2026-10-01T09:00:00-05:00', stale: false },
  obligations: [], settledObligations: new Map(),
  // Salary on the 15th: the plan covers 1–14 October (14 days).
  incomes: [{ id: 'sal', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 15, dayMax: null, secondDay: null, anchorDate: null }],
  settledIncomes: new Map(), essentialsMonthlyMinor: 0, cushionMinor: 0, ...o,
});
const trip = (o: Partial<Reserve> = {}): Reserve => ({ id: 'r1', name: 'Viaje', currency: 'PEN', savedMinor: 80000, targetMinor: null, targetDate: null, ...o });

describe('Apartados in Dinero libre', () => {
  it('what is saved is set aside: S/ 800 saved → S/ 800 less free money, one "Apartado: Viaje" line', () => {
    const without = buildPlan(input());
    const p = buildPlan(input({ reserves: [trip()] }));
    expect(p.lines).toEqual([expect.objectContaining({ kind: 'fund', label: 'Apartado: Viaje', amountMinor: 80000, reserveId: 'r1' })]);
    expect(p.freeMinor).toBe(without.freeMinor! - 80000);
    expect(p.status).toBe(without.status); // a reserve never makes the plan less certain
    expect(planBreakdown(p)).toMatchObject({ committedMinor: 0, setAsideMinor: 80000 });
  });

  it('distributing an income that just arrived does not subtract the apartado again (it lives in the balance)', () => {
    const p = buildPlan(input({ base: { kind: 'income', amountMinor: 400000, date: '2026-10-01' }, reserves: [trip({ targetMinor: 120000, targetDate: '2026-11-30' })] }));
    expect(p.lines.map((l) => l.kind)).toEqual(['reserve']); // only this horizon's planned contribution
  });

  it('review m1: from an income, what was set aside AFTER it arrived is not free (net, never above what is saved)', () => {
    const entries = [
      { reserveId: 'r1', direction: 'in' as const, amountMinor: 50000, on: '2026-09-20' }, // before the income: in the balance
      { reserveId: 'r1', direction: 'in' as const, amountMinor: 30000, on: '2026-10-01' }, // from this income
      { reserveId: 'r1', direction: 'out' as const, amountMinor: 10000, on: '2026-10-02' },
      { reserveId: 'r2', direction: 'out' as const, amountMinor: 5000, on: '2026-10-02' }, // net < 0 → nothing
    ];
    const since = setAsideSince(entries, '2026-10-01');
    expect(since).toEqual(new Map([['r1', 20000], ['r2', -5000]]));
    const base = { kind: 'income' as const, amountMinor: 400000, date: '2026-10-01' };
    const p = buildPlan(input({ base, reserves: [trip(), trip({ id: 'r2', name: 'Fondo', savedMinor: 10000 })], setAsideSinceIncome: since }));
    expect(p.lines).toEqual([expect.objectContaining({ kind: 'fund', label: 'Apartado: Viaje', amountMinor: 20000, reserveId: 'r1', note: 'Lo apartaste de este ingreso: no es dinero libre' })]);
    expect(p.freeMinor).toBe(400000 - 20000);
    // Never more than what the apartado holds now; the balance plan is unchanged (it subtracts all that is saved).
    expect(buildPlan(input({ base, reserves: [trip({ savedMinor: 5000 })], setAsideSinceIncome: since })).lines[0]!.amountMinor).toBe(5000);
    expect(buildPlan(input({ reserves: [trip()], setAsideSinceIncome: since })).lines).toEqual([expect.objectContaining({ amountMinor: 80000 })]);
  });

  it('saved money is real: never rounded (S/ 800.55 stays 80055)', () => {
    expect(buildPlan(input({ reserves: [trip({ savedMinor: 80055 })] })).lines[0]!.amountMinor).toBe(80055);
  });

  it('a dated target adds this horizon\'s contribution; no target or no date → nothing planned (never invented)', () => {
    // Target S/ 1,200 on 30 Nov (60 days from 1 Oct), S/ 300 saved, horizon 14 days → 900 × 14 / 60 = 210.
    const p = buildPlan(input({ reserves: [trip({ savedMinor: 30000, targetMinor: 120000, targetDate: '2026-11-30' })] }));
    expect(p.lines.map((l) => [l.kind, l.label, l.amountMinor])).toEqual([['reserve', 'Para Viaje', 21000], ['fund', 'Apartado: Viaje', 30000]]);
    expect(p.lines[0]!.note).toBe('Meta S/ 1,200.00 al 30/11');
    expect(buildPlan(input({ reserves: [trip({ targetMinor: 120000 })] })).lines.map((l) => l.kind)).toEqual(['fund']);
    expect(buildPlan(input({ reserves: [trip({ savedMinor: 0 })] })).lines).toEqual([]);
  });

  it('PEN ≠ USD: a USD apartado never reaches the PEN plan (and vice versa)', () => {
    const usd = trip({ id: 'r2', currency: 'USD', savedMinor: 50000, targetMinor: 100000, targetDate: '2026-11-30' });
    expect(buildPlan(input({ reserves: [usd] })).lines).toEqual([]);
    const usdPlan = buildPlan(input({ currency: 'USD', reserves: [usd, trip()], incomes: [], base: { kind: 'balance', amountMinor: 90000, asOf: '2026-10-01T09:00:00-05:00', stale: false } }));
    expect(usdPlan.lines.every((l) => l.reserveId !== 'r1')).toBe(true);
  });
});

describe('reserveContribution (pure)', () => {
  it('target S/ 1,200 in 60 days, 20-day horizon → S/ 400', () => {
    expect(reserveContribution({ savedMinor: 0, targetMinor: 120000, targetDate: '2026-11-30' }, '2026-10-01', '2026-10-20')).toBe(40000);
  });
  it('reached → 0; due inside the horizon → all that remains; no target / no date → null', () => {
    expect(reserveContribution({ savedMinor: 120000, targetMinor: 120000, targetDate: '2026-11-30' }, '2026-10-01', '2026-10-20')).toBe(0);
    expect(reserveContribution({ savedMinor: 130000, targetMinor: 120000, targetDate: '2026-11-30' }, '2026-10-01', '2026-10-20')).toBe(0);
    expect(reserveContribution({ savedMinor: 20055, targetMinor: 120000, targetDate: '2026-10-10' }, '2026-10-01', '2026-10-20')).toBe(99945);
    expect(reserveContribution({ savedMinor: 0, targetMinor: 120000, targetDate: null }, '2026-10-01', '2026-10-20')).toBeNull();
    expect(reserveContribution({ savedMinor: 0, targetMinor: null, targetDate: null }, '2026-10-01', '2026-10-20')).toBeNull();
  });
  it('planned share is rounded to whole units and never above what remains', () => {
    const c = reserveContribution({ savedMinor: 0, targetMinor: 100001, targetDate: '2026-12-31' }, '2026-10-01', '2026-10-14')!;
    expect(c % 100).toBe(0);
    expect(c).toBeLessThanOrEqual(100001);
  });
});

describe('reserveProgress (pure): suggested monthly = remaining / months left', () => {
  it('S/ 300 of S/ 1,200, three months left → S/ 300 a month, 25 %', () => {
    expect(reserveProgress({ savedMinor: 30000, targetMinor: 120000, targetDate: '2026-12-31' }, '2026-10-01'))
      .toEqual({ savedMinor: 30000, targetMinor: 120000, remainingMinor: 90000, ratio: 0.25, reached: false, monthsLeft: 3, monthlyMinor: 30000, late: false });
    expect(reserveProgress({ savedMinor: 30000, targetMinor: 120000, targetDate: '2026-11-30' }, '2026-10-01')).toMatchObject({ monthsLeft: 2, monthlyMinor: 45000 });
  });
  it('the last month asks for exactly what remains (integer minor units, no rounding of real money)', () => {
    expect(reserveProgress({ savedMinor: 30055, targetMinor: 120000, targetDate: '2026-10-20' }, '2026-10-01')).toMatchObject({ monthsLeft: 1, monthlyMinor: 89945 });
  });
  it('no target → no ratio, no remaining (unknown ≠ 0); reached; a passed date not reached is late', () => {
    expect(reserveProgress({ savedMinor: 5000, targetMinor: null, targetDate: null }, '2026-10-01')).toMatchObject({ remainingMinor: null, ratio: null, reached: false, monthlyMinor: null });
    expect(reserveProgress({ savedMinor: 120000, targetMinor: 120000, targetDate: '2026-12-31' }, '2026-10-01')).toMatchObject({ reached: true, ratio: 1, monthlyMinor: 0 });
    expect(reserveProgress({ savedMinor: 10000, targetMinor: 120000, targetDate: '2026-09-01' }, '2026-10-01')).toMatchObject({ late: true, monthsLeft: 1, monthlyMinor: 110000 });
    expect(reserveProgress({ savedMinor: 10000, targetMinor: 120000, targetDate: null }, '2026-10-01')).toMatchObject({ monthlyMinor: null, remainingMinor: 110000 });
  });
});

describe('infrequent payments: one switch between the accepted rule and the time-aware one (pending PO)', () => {
  // SOAT S/ 600 yearly, due 10 Nov; today 5 Oct, salary on the 20th → horizon 5–19 Oct (15 days), 36 days to the due date.
  const soat: Obligation = { id: 'soat', source: 'obligation', name: 'SOAT', kind: 'insurance', currency: 'PEN', amountMinor: 60000, amountStatus: 'confirmed',
    frequency: 'yearly', anchorMonth: 11, dueDay: 10, dueDayMax: null, targetDay: null, since: '2026-01-01' };
  const soatInput = (o: Partial<PlanInput> = {}) => input({
    today: '2026-10-05', obligations: [soat],
    incomes: [{ id: 'sal', name: 'Sueldo', currency: 'PEN', amountMinor: 400000, amountStatus: 'confirmed', frequency: 'monthly', dayOfMonth: 20, dayMax: null, secondDay: null, anchorDate: null }],
    ...o,
  });
  it('default stays the accepted proportional rule (S/ 25) until the PO approves', () => {
    expect(INFREQUENT_RESERVE_RULE).toBe('proportional');
    expect(buildPlan(soatInput()).lines).toEqual([expect.objectContaining({ kind: 'reserve', label: 'Para SOAT', amountMinor: 2500 })]);
  });
  it('abonos already made toward the SOAT lower what is set aside; fully covered → nothing (planned ≠ paid)', () => {
    const paidPart = new Map([['soat', new Map([['2026-11', 30000]])]]);
    expect(buildPlan(soatInput({ partialPaid: paidPart })).lines).toEqual([expect.objectContaining({ amountMinor: 1200 })]); // 300 × 15 / 365.25
    expect(buildPlan(soatInput({ partialPaid: paidPart, infrequentRule: 'time_left' })).lines).toEqual([expect.objectContaining({ amountMinor: 12500 })]);
    expect(buildPlan(soatInput({ partialPaid: new Map([['soat', new Map([['2026-11', 60000]])]]) })).lines).toEqual([]);
  });
  it('review M4: an apartado named like the SOAT is flagged (the plan would set money aside twice); nothing is merged', () => {
    const r = (name: string, currency: 'PEN' | 'USD' = 'PEN') => trip({ id: name, name, currency });
    const monthly: Obligation = { ...soat, id: 'luz', name: 'Luz', frequency: 'monthly', anchorMonth: null };
    const unknown: Obligation = { ...soat, id: 'tax', name: 'Predial', amountMinor: null, amountStatus: 'unknown' };
    const ended: Obligation = { ...soat, id: 'old', name: 'Seguro auto', endedOn: '2026-09-30' };
    const debt: Obligation = { ...soat, id: 'loan', source: 'debt', name: 'Préstamo' };
    const flagged = reserveOverlaps([r('SOAT'), r('Pago del soat 2027'), r('SOAT', 'USD'), r('Viaje'), r('Luz'), r('Predial'), r('Seguro auto'), r('Préstamo')],
      [soat, monthly, unknown, ended, debt], '2026-10-05');
    expect(flagged).toEqual(new Map([['SOAT', 'SOAT'], ['Pago del soat 2027', 'SOAT']]));
    // The plan itself is unchanged (a name is not proof): both lines stay until the person decides.
    expect(buildPlan(soatInput({ reserves: [trip({ name: 'SOAT', savedMinor: 30000 })] })).lines.map((l) => l.kind)).toEqual(['reserve', 'fund']);
  });
  it('time_left: 600 × 15 / 36 → S/ 250', () => {
    expect(buildPlan(soatInput({ infrequentRule: 'time_left' })).lines).toEqual([expect.objectContaining({ kind: 'reserve', label: 'Para SOAT', amountMinor: 25000 })]);
  });
});

describe('Aplicar plan keeps fund lines (defense in depth on read-back)', () => {
  it('a stored "fund" line is valid and counts as reserved, never as paid', () => {
    expect(validAppliedLines([{ kind: 'fund', label: 'Apartado: Viaje', amountMinor: 80000, date: null, obligationId: null, period: null }]))
      .toEqual([{ kind: 'fund', label: 'Apartado: Viaje', amountMinor: 80000, date: null, obligationId: null, period: null }]);
  });
});
