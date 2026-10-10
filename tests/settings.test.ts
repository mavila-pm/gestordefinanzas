import { describe, expect, it } from 'vitest';
import { velsUsage } from '../src/ai/entitlements';
import { alertAllowed, DEFAULT_PREFERENCES, parsePreferences, preferencesFrom, reduceMotionFrom, textSizeFrom } from '../src/web/preferences';

const form = (o: Record<string, string>) => (k: string) => o[k] ?? null;

describe('Ajustes → Plan y uso: "Uso de Vels" from real allowance data', () => {
  const now = new Date('2026-10-10T15:00:00Z');
  it('B: percent = used / limit of the current period, rounded, capped at 100', () => {
    expect(velsUsage({ plan: 'free', conversation: { used: 14500, limit: 25000, ratio: 0.58 } }, now, null).percent).toBe(58);
    expect(velsUsage({ plan: 'free', conversation: { used: 99999, limit: 25000, ratio: 1 } }, now, null).percent).toBe(100);
  });
  it('C: a monthly allowance renews on the 1st of next month (Lima); a trial when it ends', () => {
    expect(velsUsage({ plan: 'free', conversation: { used: 0, limit: 25000, ratio: 0 } }, now, null)).toMatchObject({ resetAt: '2026-11-01', renews: 'monthly' });
    expect(velsUsage({ plan: 'plus', conversation: { used: 0, limit: 1, ratio: 0 } }, new Date('2026-12-31T23:00:00Z'), null).resetAt).toBe('2027-01-01');
    expect(velsUsage({ plan: 'free', conversation: { used: 0, limit: 1, ratio: 0 } }, new Date('2026-11-01T03:00:00Z'), null).resetAt).toBe('2026-11-01');
    expect(velsUsage({ plan: 'trial', conversation: { used: 0, limit: 1, ratio: 0 } }, now, '2026-10-20T15:00:00Z')).toMatchObject({ resetAt: '2026-10-20', renews: 'trial_end' });
  });
  it('D: no configured limit → no percent (never invented)', () => {
    expect(velsUsage({ plan: 'free', conversation: { used: 500, limit: 0, ratio: 1 } }, now, null).percent).toBeNull();
  });
});

describe('Ajustes → preferences are whitelisted and default safely', () => {
  it('M, N, O: Vels style, main currency and main account; anything else is refused', () => {
    expect(parsePreferences('vels', form({ velsStyle: 'brief', velsProactive: 'on' }))).toEqual({ vels_style: 'brief', vels_proactive: true });
    expect(parsePreferences('vels', form({ velsStyle: 'verbose' }))).toBeNull();
    expect(parsePreferences('finance', form({ primaryCurrency: 'USD', primaryAccountId: '0b4f2d1c-0000-4000-8000-00000000000a' })))
      .toEqual({ primary_currency: 'USD', primary_account_id: '0b4f2d1c-0000-4000-8000-00000000000a' });
    expect(parsePreferences('finance', form({ primaryCurrency: 'PEN', primaryAccountId: '' }))).toEqual({ primary_currency: 'PEN', primary_account_id: null });
    expect(parsePreferences('finance', form({ primaryCurrency: 'EUR' }))).toBeNull();
    expect(parsePreferences('finance', form({ primaryCurrency: 'PEN', primaryAccountId: "1' or 1=1" }))).toBeNull();
    expect(parsePreferences('admin', form({}))).toBeNull();
  });
  it('H: notices are four switches; an unchecked box is off', () => {
    expect(parsePreferences('notifications', form({ notifyUpcoming: 'on', notifyLimits: 'on' })))
      .toEqual({ notify_upcoming: true, notify_review: false, notify_monthly: false, notify_limits: true });
  });
  it('defaults when nothing is stored; notices filter only what the person turned off', () => {
    expect(preferencesFrom(null)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({ vels_style: 'x', primary_currency: 'GBP' })).toMatchObject({ velsStyle: 'balanced', primaryCurrency: 'PEN' });
    const off = { ...DEFAULT_PREFERENCES, notifyLimits: false, notifyUpcoming: false };
    expect(alertAllowed('budget_exceeded:Ocio', off)).toBe(false);
    expect(alertAllowed('debt_due:abc', off)).toBe(false);
    expect(alertAllowed('unusual_expense', off)).toBe(true);
  });
  it('P, Q: text size and reduced motion cookies parse to safe values', () => {
    expect(textSizeFrom('lg')).toBe('lg');
    expect(textSizeFrom('huge')).toBe('md');
    expect(reduceMotionFrom('reduce')).toBe(true);
    expect(reduceMotionFrom(undefined)).toBe(false);
  });
});

import { answer, detectIntent, proactiveNote, styleAnswer, type View } from '../src/ai/vels-answers';

describe('Ajustes → Vels: style changes presentation only; proactive is one line at most', () => {
  const view: View = {
    today: '2026-10-10', obligations: [], debts: [], reviewCount: 0, suggestions: [],
    plans: [{ currency: 'PEN', base: { amountMinor: 385000, date: '2026-10-10', status: 'confirmed' }, freeMinor: 136200, reservedMinor: 248800, until: '2026-10-27', lines: [], missing: [], status: 'confirmed' } as never],
    timeline: [{ date: '2026-10-12', dateMax: null, kind: 'debt', label: 'Préstamo vehicular BCP', currency: 'PEN', amountMinor: 95000, amountStatus: 'confirmed', overdue: false, refId: 'd1' }],
  };
  it('M: "Breves" keeps the sentence and its numbers, drops the rows; the engine amount is identical', () => {
    const a = { text: 'Tienes S/ 1,362.00 disponibles hasta el 27 de octubre.', rows: [{ label: 'Saldo', value: 'S/ 3,850.00' }] };
    expect(styleAnswer(a, 'brief')).toEqual({ text: a.text, rows: undefined });
    expect(styleAnswer(a, 'balanced')).toBe(a);
    expect(styleAnswer(a, 'detailed')).toBe(a);
  });
  it('proactive: review first, then a payment due within 2 days, else nothing', () => {
    expect(proactiveNote({ ...view, reviewCount: 2 })).toBe('Tienes 2 movimientos por revisar.');
    expect(proactiveNote(view)).toBe('El 12 vence Préstamo vehicular BCP (S/ 950).');
    expect(proactiveNote({ ...view, timeline: [] })).toBeNull();
  });
  it('connecting the mail starts in Vels, as a guided step (no settings screen)', () => {
    expect(detectIntent('Quiero conectar mi correo')).toEqual({ k: 'connect_email' });
    const a = answer({ k: 'connect_email' }, view)!;
    expect(a.text).toMatch(/^Claro\. Te ayudo a hacerlo/);
    expect(a.actions?.[0]).toMatchObject({ type: 'link', href: '/app/conexiones' });
  });
});
