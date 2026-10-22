import { describe, expect, it } from 'vitest';
import { annualSavingPercent, isPlanCode, limaDatePlus } from '../src/domain/billing';

describe('billing (pure)', () => {
  it('annual saving only when it really saves', () => {
    expect(annualSavingPercent(400, 5900)).toBeNull(); // launch: 12 × US$ 4 = 48 < 59
    expect(annualSavingPercent(900, 5900)).toBe(45); // from 2027: 12 × US$ 9 = 108
  });
  it('plan codes are validated (untrusted form input)', () => {
    expect(isPlanCode('annual')).toBe(true);
    expect(isPlanCode('weekly')).toBe(false);
    expect(isPlanCode(undefined)).toBe(false);
  });
  it('trial end date in Lima', () => {
    expect(limaDatePlus(new Date('2026-10-12T03:00:00Z'), 14)).toBe('2026-10-25');
  });
});

describe('billing display and input (pure, ADR-0018)', () => {
  it('billing dates in Lima with the year', async () => {
    const { billingDate } = await import('../src/domain/billing');
    expect(billingDate('2027-10-22T04:59:00Z')).toBe('21 de octubre de 2027');
    expect(billingDate('2027-10-22T05:00:00Z')).toBe('22 de octubre de 2027');
  });
  it('Plan y uso: paid trial shows its first charge; cancel keeps Plus until the end; lifetime has no renewal', async () => {
    const { paidPlanView } = await import('../src/domain/billing');
    const base = { status: 'trialing', billing_plan: 'monthly', trial_ends_at: '2026-11-05T15:00:00Z', current_period_end: '2026-11-05T15:00:00Z', cancel_at_period_end: false, billing_amount_minor: '400', provider_ref: 'sxn_test_a1' };
    expect(paidPlanView(base)).toEqual({ plan: 'monthly', phase: 'trial', until: base.trial_ends_at, nextCharge: { at: base.trial_ends_at, amountMinor: 400 }, canCancel: true });
    expect(paidPlanView({ ...base, cancel_at_period_end: true })).toMatchObject({ phase: 'ending', nextCharge: null, canCancel: false, until: base.trial_ends_at });
    expect(paidPlanView({ ...base, status: 'active', current_period_end: '2026-12-05T15:00:00Z' })).toMatchObject({ phase: 'active', nextCharge: { at: '2026-12-05T15:00:00Z', amountMinor: 400 } });
    expect(paidPlanView({ ...base, status: 'past_due' })).toMatchObject({ phase: 'past_due', nextCharge: null, canCancel: true });
    expect(paidPlanView({ ...base, billing_plan: 'lifetime', status: 'active' })).toEqual({ plan: 'lifetime', phase: 'lifetime', until: null, nextCharge: null, canCancel: false });
    expect(paidPlanView({ ...base, billing_plan: 'lifetime', status: 'canceled' })).toBeNull();
    expect(paidPlanView({ ...base, billing_plan: null })).toBeNull();
    expect(paidPlanView({ ...base, status: 'canceled' })).toBeNull();
    expect(paidPlanView({ ...base, provider_ref: null })).toMatchObject({ canCancel: false });
  });
  it('Culqi customer from the profile + the asked address; nothing invented', async () => {
    const { billingCustomer, culqiPhone, isTokenId } = await import('../src/web/billing-input');
    const profile = { given_names: ' Ana  María ', family_names: 'Pérez Soto', phone_e164: '+51987654321' };
    expect(billingCustomer(profile, ' Av. Arequipa 123 ', 'Lima')).toEqual({ firstName: 'Ana María', lastName: 'Pérez Soto', phoneNumber: '987654321', address: 'Av. Arequipa 123', addressCity: 'Lima' });
    expect(billingCustomer({ ...profile, family_names: null }, 'Av. 1', 'Lima')).toEqual({ error: 'profile' });
    expect(billingCustomer({ ...profile, phone_e164: '+14155550100' }, 'Av. 1', 'Lima')).toEqual({ error: 'phone' });
    expect(billingCustomer(profile, '', 'Lima')).toEqual({ error: 'address' });
    expect(billingCustomer(profile, 'Av. 1', '<b>Lima</b>')).toEqual({ error: 'city' });
    expect(billingCustomer(null, 'Av. 1', 'Lima')).toEqual({ error: 'profile' });
    expect(culqiPhone('+51912345678')).toBe('912345678');
    expect(culqiPhone('+51812345678')).toBeNull();
    expect(isTokenId('tkn_test_Z9y8X7w6V5u4T3s2')).toBe(true);
    for (const bad of ['crd_test_Z9y8X7w6V5u4T3s2', 'tkn_test_../x', '', null]) expect(isTokenId(bad)).toBe(false);
  });
});
