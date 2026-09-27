import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/domain/types';
import { buildAlerts } from '../src/engine/alerts';
import { dataHealth } from '../src/engine/data-health';
import { closedMonthMilestone, mainInsight } from '../src/engine/insights';

let n = 0;
const tx = (o: Partial<Transaction>): Transaction => ({
  id: `t${++n}`, userId: 'u', occurredAt: '2026-09-10T12:00:00-05:00', type: 'expense', direction: 'outflow', amountMinor: 1000,
  currency: 'PEN', institution: null, cardLast4: null, merchantRaw: 'X', merchantNormalized: 'X', category: 'Otros',
  status: 'confirmed', confidence: 'high', fingerprint: 'f', sources: [], originalTransactionId: null, duplicateOfId: null, ...o,
});
const month = (m: string, income: number, expense: number, extra: Partial<Transaction>[] = []) => [
  tx({ occurredAt: `${m}-01T09:00:00-05:00`, type: 'income', direction: 'inflow', amountMinor: income, category: null }),
  tx({ occurredAt: `${m}-15T12:00:00-05:00`, amountMinor: expense }),
  ...extra.map((e) => tx({ occurredAt: `${m}-20T12:00:00-05:00`, ...e })),
];

describe('main insight (§40)', () => {
  it('names the category that explains most of the increase, with its share', () => {
    const txs = [
      tx({ occurredAt: '2026-08-10T12:00:00-05:00', amountMinor: 50000, category: 'Alimentación' }),
      tx({ occurredAt: '2026-08-11T12:00:00-05:00', amountMinor: 20000, category: 'Transporte' }),
      tx({ amountMinor: 81000, category: 'Alimentación' }),
      tx({ amountMinor: 40000, category: 'Transporte' }),
    ];
    expect(mainInsight(txs, '2026-09', 'PEN')).toEqual({ estimated: false,
      text: 'Alimentación aumentó S/ 310.00 y explica el 61% del incremento de tus gastos frente a 2026-08.' });
  });
  it('is marked estimated with pending movements; nothing without a previous month', () => {
    const txs = [tx({ occurredAt: '2026-08-10T12:00:00-05:00', amountMinor: 100 }), tx({ amountMinor: 500 }), tx({ amountMinor: 1, status: 'review_required' })];
    expect(mainInsight(txs, '2026-09', 'PEN')?.estimated).toBe(true);
    expect(mainInsight([tx({})], '2026-09', 'PEN')).toBeNull();
  });
});

describe('FinancialMilestoneEngine (§41-45)', () => {
  const ok = { firstName: 'Mauro', dataHealthOk: true };
  it('monthly saving, improvement and consistency (only one, most significant)', () => {
    expect(closedMonthMilestone(month('2026-09', 550000, 421600), '2026-09', 'PEN', ok)).toEqual({ kind: 'monthly_saving', month: '2026-09',
      text: 'Felicidades, Mauro. Cerraste septiembre con S/ 1,284.00 de ahorro.' });
    const two = [...month('2026-08', 500000, 402600), ...month('2026-09', 550000, 421600)];
    expect(closedMonthMilestone(two, '2026-09', 'PEN', ok)?.text).toBe('Felicidades, Mauro. Cerraste septiembre con S/ 1,284.00 de ahorro, S/ 310.00 más que en agosto.');
    const three = [...month('2026-07', 500000, 400000), ...two];
    expect(closedMonthMilestone(three, '2026-09', 'PEN', ok)?.kind).toBe('consistency');
  });
  it('confidence gate: never with pending movements, unhealthy data, negative month or no income', () => {
    expect(closedMonthMilestone(month('2026-09', 550000, 421600, [{ status: 'review_required' }]), '2026-09', 'PEN', ok)).toBeNull();
    expect(closedMonthMilestone(month('2026-09', 550000, 421600), '2026-09', 'PEN', { dataHealthOk: false })).toBeNull();
    expect(closedMonthMilestone(month('2026-09', 100000, 200000), '2026-09', 'PEN', ok)).toBeNull();
    expect(closedMonthMilestone([tx({})], '2026-09', 'PEN', ok)).toBeNull();
  });
  it('card payments and ATM withdrawals do not reduce the celebrated saving', () => {
    const m = month('2026-09', 500000, 100000, [{ type: 'credit_card_payment', amountMinor: 100000, category: null }, { type: 'withdrawal', amountMinor: 50000, category: null }]);
    expect(closedMonthMilestone(m, '2026-09', 'PEN', { dataHealthOk: true })?.text).toBe('Felicidades. Cerraste septiembre con S/ 4,000.00 de ahorro.');
  });
});

describe('data health (§58) and alerts (§46)', () => {
  it('levels with reasons, no score', () => {
    expect(dataHealth({ pendingCount: 0, oldestPendingDays: null, unresolvedEvents30d: 0, automaticSources: 1 })).toEqual({ level: 'HEALTHY', reasons: [] });
    expect(dataHealth({ pendingCount: 2, oldestPendingDays: 1, unresolvedEvents30d: 0, automaticSources: 1 }).level).toBe('PARTIAL');
    expect(dataHealth({ pendingCount: 0, oldestPendingDays: null, unresolvedEvents30d: 0, automaticSources: 0 }).level).toBe('PARTIAL');
    expect(dataHealth({ pendingCount: 12, oldestPendingDays: 1, unresolvedEvents30d: 0, automaticSources: 1 }).level).toBe('ACTION_REQUIRED');
    expect(dataHealth({ pendingCount: 1, oldestPendingDays: 9, unresolvedEvents30d: 0, automaticSources: 1 }).level).toBe('ACTION_REQUIRED');
  });

  it('alerts: pending, unreadable messages, unusual expense; at most 3, most important first', () => {
    const now = new Date('2026-09-27T12:00:00-05:00');
    const base = Array.from({ length: 6 }, (_, i) => tx({ occurredAt: `2026-09-0${i + 1}T12:00:00-05:00`, amountMinor: 4000 }));
    const big = tx({ occurredAt: '2026-09-25T12:00:00-05:00', amountMinor: 90000, merchantRaw: 'TIENDA RARA' });
    const alerts = buildAlerts({ txs: [...base, big], pendingCount: 3, oldestPendingDays: 10, unresolvedEvents30d: 2, now, currency: 'PEN' });
    expect(alerts.map((a) => [a.level, a.code])).toEqual([['IMPORTANT', 'pending'], ['INFORMATIONAL', 'unresolved'], ['INFORMATIONAL', 'unusual_expense']]);
    expect(alerts[2]!.text).toContain('S/ 900.00 en TIENDA RARA');
    // Card payment / withdrawal are never "unusual expenses".
    const noExpense = buildAlerts({ txs: [...base, tx({ occurredAt: '2026-09-25T12:00:00-05:00', type: 'withdrawal', amountMinor: 90000 })], pendingCount: 0, oldestPendingDays: null, unresolvedEvents30d: 0, now, currency: 'PEN' });
    expect(noExpense).toEqual([]);
  });
});

import { budgetStatus } from '../src/engine/budgets';

describe('budgets (§42, §46)', () => {
  const txs = [
    tx({ amountMinor: 30000, category: 'Alimentación' }), tx({ amountMinor: 15000, category: 'Alimentación' }),
    tx({ type: 'refund', direction: 'inflow', amountMinor: 5000, category: 'Alimentación' }),
    tx({ amountMinor: 8500, category: 'Transporte' }),
    tx({ amountMinor: 99999, category: 'Transporte', status: 'review_required' }),
    tx({ type: 'withdrawal', amountMinor: 50000, category: null }),
  ];
  const budgets = [
    { category: 'Alimentación', currency: 'PEN' as const, amountMinor: 35000 },
    { category: 'Transporte', currency: 'PEN' as const, amountMinor: 10000 },
    { category: 'Ocio', currency: 'PEN' as const, amountMinor: 20000 },
  ];
  it('spent = confirmed expenses minus refunds; pending and withdrawals excluded', () => {
    expect(budgetStatus(txs, '2026-09', budgets).map((b) => [b.category, b.spentMinor, b.state])).toEqual([
      ['Alimentación', 40000, 'exceeded'], ['Transporte', 8500, 'warning'], ['Ocio', 0, 'ok']]);
  });
  it('alerts for exceeded (IMPORTANT) and 80% (INFORMATIONAL)', () => {
    const a = buildAlerts({ txs: [], pendingCount: 0, oldestPendingDays: null, unresolvedEvents30d: 0, now: new Date('2026-09-27T12:00:00Z'), currency: 'PEN', budgets: budgetStatus(txs, '2026-09', budgets) });
    expect(a.map((x) => [x.level, x.code])).toEqual([['IMPORTANT', 'budget_exceeded:Alimentación'], ['INFORMATIONAL', 'budget_warning:Transporte']]);
    expect(a[0]!.text).toBe('Presupuesto excedido: Alimentación lleva S/ 400.00 de S/ 350.00 (S/ 50.00 por encima).');
  });
  it('category milestone when a budgeted category stayed under its limit (after consistency/improvement)', () => {
    const m = [
      tx({ occurredAt: '2026-09-01T09:00:00-05:00', type: 'income', direction: 'inflow', amountMinor: 300000, category: null }),
      tx({ occurredAt: '2026-09-10T12:00:00-05:00', amountMinor: 28000, category: 'Alimentación' }),
    ];
    expect(closedMonthMilestone(m, '2026-09', 'PEN', { firstName: 'Mauro', dataHealthOk: true, budgets: [{ category: 'Alimentación', currency: 'PEN', amountMinor: 50000 }] })?.text)
      .toBe('Buen cierre, Mauro. Mantuviste Alimentación S/ 220.00 por debajo de tu límite en septiembre, y ahorraste S/ 2,720.00.');
  });
});
