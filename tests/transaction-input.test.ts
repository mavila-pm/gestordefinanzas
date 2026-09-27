import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/domain/types';
import { parseIngestionCodes, reviewReasons } from '../src/engine/review-reasons';
import {
  errorText, formatLimaDateTime, isoToLimaInputs, limaDateTimeToIso, minorToInput, parseCardForm, parseCorrectionForm,
  parseManualForm, parseReviewForm, type CorrectableState,
} from '../src/web/transaction-input';

const REF = '7f1c1a3e-2b1d-4e5f-9a8b-0c1d2e3f4a5b';
const CAT = '11111111-1111-4111-8111-111111111111';
const CARD = '22222222-2222-4222-8222-222222222222';
const form = (o: Record<string, string>) => (k: string) => o[k] ?? null;

const manual = (o: Record<string, string> = {}) => parseManualForm(form({
  clientRef: REF, type: 'expense', amount: '82.50', currency: 'PEN', date: '2026-09-20', time: '13:05', description: 'Almuerzo Pollería', ...o,
}));

describe('manual entry validation (server-side, first layer)', () => {
  it('parses a valid form into integer minor units and Lima time', () => {
    const r = manual();
    expect(r).toEqual({ ok: true, value: {
      clientRef: REF, type: 'expense', amountMinor: 8250, currency: 'PEN', occurredAt: '2026-09-20T13:05:00-05:00',
      description: 'Almuerzo Pollería', descriptionNormalized: 'ALMUERZO POLLERIA', categoryId: null, cardId: null, accountId: null,
    } });
  });

  it('never uses floats: "1,234.56" -> 123456 minor units', () => {
    expect(manual({ amount: '1,234.56' })).toMatchObject({ ok: true, value: { amountMinor: 123456 } });
  });

  it('rejects types that only banks can report and any unknown value', () => {
    for (const type of ['credit_card_purchase', 'deposit', 'reversal', 'unknown', 'hack', '']) {
      expect(manual({ type })).toEqual({ ok: false, error: 'invalid_type' });
    }
  });

  it('rejects bad amounts, currencies, dates and descriptions', () => {
    for (const amount of ['0', '-5', '1.234', 'abc', '1e3', '', '1000000000.01']) expect(manual({ amount })).toEqual({ ok: false, error: 'invalid_amount' });
    expect(manual({ currency: 'EUR' })).toEqual({ ok: false, error: 'invalid_currency' });
    expect(manual({ date: '2026-02-31' })).toEqual({ ok: false, error: 'invalid_date' });
    expect(manual({ date: '20/09/2026' })).toEqual({ ok: false, error: 'invalid_date' });
    expect(manual({ description: 'x'.repeat(121) })).toEqual({ ok: false, error: 'invalid_description' });
    expect(manual({ description: 'hola\u0000' })).toEqual({ ok: false, error: 'invalid_description' });
    expect(manual({ clientRef: 'not-a-uuid' })).toEqual({ ok: false, error: 'invalid_request' });
    expect(manual({ categoryId: "1' or '1'='1" })).toEqual({ ok: false, error: 'invalid_category' });
    expect(manual({ cardId: 'x' })).toEqual({ ok: false, error: 'invalid_card' });
  });

  it('drops a category for types that do not carry one (withdrawal, card payment, transfer, income)', () => {
    for (const type of ['withdrawal', 'credit_card_payment', 'internal_transfer', 'income']) {
      expect(manual({ type, categoryId: CAT })).toMatchObject({ ok: true, value: { categoryId: null } });
    }
    expect(manual({ type: 'refund', categoryId: CAT })).toMatchObject({ ok: true, value: { categoryId: CAT } });
  });
});

describe('correction diff', () => {
  const current: CorrectableState = {
    type: 'expense', amountMinor: 10000, currency: 'PEN', occurredAt: '2026-09-15T20:30:00-05:00',
    merchantRaw: 'RESTAURANTE X', categoryId: CAT, cardId: null, accountId: null,
  };
  const base = { id: REF, type: 'expense', amount: '100.00', currency: 'PEN', date: '2026-09-15', time: '20:30', description: 'RESTAURANTE X', categoryId: CAT };
  const correct = (o: Record<string, string> = {}) => parseCorrectionForm(form({ ...base, ...o }), current);

  it('sends only the fields that changed', () => {
    expect(correct()).toEqual({ ok: true, value: { id: REF, changes: {}, confirm: false } });
    expect(correct({ amount: '95.5', confirm: '1' })).toEqual({ ok: true, value: { id: REF, changes: { amount_minor: 9550 }, confirm: true } });
    expect(correct({ cardId: CARD })).toMatchObject({ ok: true, value: { changes: { card_id: CARD } } });
  });

  it('description change carries its normalized form', () => {
    expect(correct({ description: 'Pollería Miraflores' })).toMatchObject({ ok: true, value: { changes: { merchant_raw: 'Pollería Miraflores', merchant_normalized: 'POLLERIA MIRAFLORES' } } });
  });

  it('type change to a non-categorizable type does not send a category', () => {
    const r = correct({ type: 'withdrawal' });
    expect(r).toEqual({ ok: true, value: { id: REF, changes: { type: 'withdrawal' }, confirm: false } });
  });

  it('never accepts direction/status or an undetermined type from the browser', () => {
    expect(correct({ type: 'unknown' })).toEqual({ ok: false, error: 'invalid_type' });
    expect(parseCorrectionForm(form({ ...base, type: '' }), { ...current, type: 'unknown' })).toEqual({ ok: false, error: 'type_required' });
    const r = correct({ direction: 'inflow', status: 'confirmed', user_id: REF });
    expect(r).toEqual({ ok: true, value: { id: REF, changes: {}, confirm: false } });
  });

  it('a date typed in Lima is compared as an instant (no spurious change)', () => {
    expect(correct({ time: '20:31' })).toMatchObject({ ok: true, value: { changes: { occurred_at: '2026-09-15T20:31:00-05:00' } } });
  });
});

describe('review and card forms', () => {
  it('review accepts only confirm/ignore on a uuid', () => {
    expect(parseReviewForm(form({ id: REF, action: 'confirm' }))).toEqual({ ok: true, value: { id: REF, action: 'confirm' } });
    expect(parseReviewForm(form({ id: REF, action: 'delete' }))).toEqual({ ok: false, error: 'invalid_request' });
    expect(parseReviewForm(form({ id: '1', action: 'ignore' }))).toEqual({ ok: false, error: 'invalid_request' });
  });

  it('cards: only last 4 digits; a full card number is refused anywhere', () => {
    const card = (o: Record<string, string> = {}) => parseCardForm(form({ alias: 'Visa', kind: 'credit', currency: 'PEN', last4: '4821', institution: 'BCP', ...o }));
    expect(card()).toEqual({ ok: true, value: { alias: 'Visa', institution: 'BCP', kind: 'credit', currency: 'PEN', last4: '4821' } });
    expect(card({ last4: '4557881234563456' })).toEqual({ ok: false, error: 'invalid_last4' });
    expect(card({ last4: '482' })).toEqual({ ok: false, error: 'invalid_last4' });
    expect(card({ alias: 'Visa 4557 8812 3456 3456' })).toEqual({ ok: false, error: 'pan_in_alias' });
    expect(card({ kind: 'prepaid' })).toEqual({ ok: false, error: 'invalid_kind' });
    expect(card({ institution: 'EVIL' })).toEqual({ ok: false, error: 'invalid_institution' });
  });
});

describe('formatting helpers', () => {
  it('Lima date/time round trip and money input', () => {
    expect(limaDateTimeToIso('2026-09-15', '20:30')).toBe('2026-09-15T20:30:00-05:00');
    expect(isoToLimaInputs('2026-09-16T01:30:00.000Z')).toEqual({ date: '2026-09-15', time: '20:30' });
    expect(formatLimaDateTime('2026-09-15T20:30:00-05:00')).toBe('15/09/2026 20:30');
    expect(minorToInput(8250)).toBe('82.50');
    expect(minorToInput(5)).toBe('0.05');
  });

  it('error codes map to user text; unknown/internal messages never leak', () => {
    expect(errorText('card_mismatch')).toMatch(/4 dígitos/);
    expect(errorText('duplicate key value violates unique constraint "x"')).toBe('No se pudo guardar. Intenta de nuevo.');
    expect(errorText(undefined)).toBe('No se pudo guardar. Intenta de nuevo.');
  });
});

describe('review reasons (plain language, no internal terms)', () => {
  const tx = (o: Partial<Transaction> = {}): Transaction => ({
    id: 't1', userId: 'u', occurredAt: '2026-09-15T20:30:00-05:00', type: 'expense', direction: 'outflow', amountMinor: 10000,
    currency: 'PEN', institution: 'BCP', cardLast4: null, merchantRaw: 'RESTAURANTE X', merchantNormalized: 'RESTAURANTE X',
    category: 'Alimentación', status: 'review_required', confidence: 'medium', fingerprint: 'fp', sources: [],
    originalTransactionId: null, duplicateOfId: null, ...o,
  });
  const ctx = { ingestionCodes: [] as string[], registeredCardLast4: [] as string[], cardId: null as string | null };
  const codes = (t: Transaction, c = ctx) => reviewReasons(t, c).map((r) => r.code);

  it('explains an unidentified card, and updates once the card is registered or linked', () => {
    expect(codes(tx({ cardLast4: '4821' }))).toEqual(['card_not_registered']);
    expect(codes(tx({ cardLast4: '4821' }), { ...ctx, registeredCardLast4: ['4821'] })).toEqual(['card_not_linked']);
    expect(codes(tx({ cardLast4: '4821' }), { ...ctx, registeredCardLast4: ['4821'], cardId: 'c1' })).toEqual(['medium_confidence']);
  });

  it('uncertain category, unknown merchant, possible duplicate, unknown type, parser codes', () => {
    expect(codes(tx({ category: 'Otros' }))).toEqual(['category_uncertain']);
    expect(codes(tx({ merchantRaw: null }))).toEqual(['merchant_unknown']);
    expect(codes(tx({ status: 'possible_duplicate' }))).toEqual(['possible_duplicate']);
    expect(codes(tx({ type: 'unknown', merchantRaw: null, category: null }))).toEqual(['unknown_type']);
    expect(codes(tx({ type: 'unknown', merchantRaw: null, category: null }), { ...ctx, ingestionCodes: ['transfer_destination_not_own'] }))
      .toEqual(['transfer_destination_not_own']);
    expect(codes(tx({ type: 'deposit', category: null }), { ...ctx, ingestionCodes: ['deposit_origin_unknown'] })).toEqual(['deposit_origin_unknown']);
  });

  it('texts never expose parser versions, fingerprints or raw codes', () => {
    const all = [
      ...reviewReasons(tx({ cardLast4: '4821', category: 'Otros', status: 'possible_duplicate' }), { ...ctx, ingestionCodes: ['sender_not_verified', 'card_missing', 'weird_code'] }),
      ...reviewReasons(tx({ type: 'unknown' }), ctx),
    ];
    for (const r of all) expect(r.text).not.toMatch(/BCP_|_V\d|fingerprint|parser|[a-z]+_[a-z]+/);
  });

  it('parses stored detail codes defensively', () => {
    expect(parseIngestionCodes('card_not_registered,sender_not_verified')).toEqual(['card_not_registered', 'sender_not_verified']);
    expect(parseIngestionCodes('no adapter for this message')).toEqual([]);
    expect(parseIngestionCodes(null)).toEqual([]);
  });
});
