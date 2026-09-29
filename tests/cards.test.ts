import { describe, expect, it } from 'vitest';
import { cardPosition, validStatement, type Statement } from '../src/engine/cards';
import { parseCardStatementForm } from '../src/web/transaction-input';

const card = { currency: 'PEN' as const, creditLimitMinor: 1000000, statementDay: 23, paymentDay: 19, annualRateBp: 6000 };
const st = (x: Partial<Statement> = {}): Statement => ({ cutDate: '2026-09-23', dueDate: '2026-10-19', billedMinor: 300000, minimumMinor: 15000, usedMinor: null, usedAsOf: null, status: 'confirmed', source: 'manual', updatedAt: '2026-09-24T00:00:00Z', ...x });

describe('card position (ADR-0014)', () => {
  it('billed, due, minimum-only carry and interest; post-cut goes to the next statement; purchase today paid next cycle', () => {
    const p = cardPosition('2026-09-29', card, st(), 45000, 200000);
    expect(p.billed).toMatchObject({ amountMinor: 300000, minimumMinor: 15000, dueDate: '2026-10-19', daysLeft: 20 });
    expect(p.minimumOnly).toEqual({ carriedMinor: 285000, interestMinor: 14250 });
    expect(p.postCutMinor).toBe(45000);
    expect(p.purchaseTodayPaidOn).toBe('2026-11-19');
    expect(p.usableMinor).toBe(200000); // used unknown → bank room unknown → plan free only
    expect(p.bankAvailableMinor).toBeNull();
  });
  it('usable = min(plan free, bank room); never negative; the bank line is never free money', () => {
    expect(cardPosition('2026-09-29', card, st({ usedMinor: 950000, usedAsOf: 'x' }), 0, 200000).usableMinor).toBe(50000);
    expect(cardPosition('2026-09-29', card, st({ usedMinor: 100000, usedAsOf: 'x' }), 0, -5000).usableMinor).toBe(0);
    expect(cardPosition('2026-09-29', card, null, null, null).usableMinor).toBeNull();
  });
  it('unknown stays unknown (never 0); an old statement is not used as current', () => {
    const u = cardPosition('2026-09-29', card, st({ billedMinor: null, minimumMinor: null }), 0, 1000);
    expect(u.billed!.amountMinor).toBeNull();
    expect(u.minimumOnly).toBeNull();
    const old = cardPosition('2026-09-29', card, st({ cutDate: '2026-08-23', dueDate: '2026-09-19' }), 0, 1000);
    expect(old.statementOutdated).toBe(true);
    expect(old.billed).toBeNull();
    expect(old.postCutMinor).toBeNull();
  });
  it('rate unknown → carried amount shown, interest not invented', () => {
    expect(cardPosition('2026-09-29', { ...card, annualRateBp: null }, st(), 0, 1).minimumOnly).toEqual({ carriedMinor: 285000, interestMinor: null });
  });
  it('manual entry: blank = unknown, "0" = zero, dates validated, minimum ≤ total', () => {
    const f = (o: Record<string, string>) => parseCardStatementForm((k) => o[k] ?? null);
    expect(f({ cutDate: '2026-09-23', dueDate: '2026-10-19', billed: '3,000.50', minimum: '', used: '0' })).toEqual({ ok: true, value: { cutDate: '2026-09-23', dueDate: '2026-10-19', billedMinor: 300050, minimumMinor: null, usedMinor: 0 } });
    expect(f({ cutDate: '2026-09-23', dueDate: '', billed: '1' }).ok).toBe(false);
    expect(f({ cutDate: '2026-09-23', dueDate: '2026-10-19', billed: '-5' }).ok).toBe(false);
    expect(validStatement({ cutDate: '2026-09-23', dueDate: '2026-09-20', billedMinor: null, minimumMinor: null, usedMinor: null })).toMatch(/después del corte/);
    expect(validStatement({ cutDate: '2026-09-23', dueDate: '2026-10-19', billedMinor: 100, minimumMinor: 200, usedMinor: null })).toMatch(/mínimo/);
    expect(validStatement({ cutDate: '2026-02-28', dueDate: '2026-03-20', billedMinor: 100, minimumMinor: 50, usedMinor: null })).toBeNull();
  });
  it('February and month-end cut days stay valid dates', () => {
    const p = cardPosition('2026-02-10', { ...card, statementDay: 31, paymentDay: 25 }, null, null, 1000);
    expect(p.nextCut).toBe('2026-02-28');
    expect(p.purchaseTodayPaidOn).toBe('2026-03-25');
  });
});
