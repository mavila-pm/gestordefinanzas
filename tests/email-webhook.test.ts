import { describe, expect, it } from 'vitest';
import { genericHmacProvider, hmacSignature } from '../src/infrastructure/inbound/email-webhook';

const SECRET = 'x'.repeat(40);
const now = new Date('2026-09-27T12:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ deliveryId: 'd1', to: 'f_abcdefghijklmnopqrstuvwx@ingest.example.pe' });
const headers = (o: Record<string, string>) => new Headers(o);
const p = genericHmacProvider(SECRET);

describe('generic HMAC webhook provider', () => {
  it('accepts a valid signature within the time window', () => {
    expect(p.verify(headers({ 'x-gf-timestamp': ts, 'x-gf-signature': hmacSignature(SECRET, ts, body) }), body, now)).toEqual({ ok: true });
  });
  it('rejects bad, missing, tampered, stale and future signatures', () => {
    const good = hmacSignature(SECRET, ts, body);
    expect(p.verify(headers({}), body, now)).toEqual({ ok: false, reason: 'missing_signature' });
    expect(p.verify(headers({ 'x-gf-timestamp': ts, 'x-gf-signature': good }), body + ' ', now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(p.verify(headers({ 'x-gf-timestamp': ts, 'x-gf-signature': hmacSignature('otro-secreto'.repeat(4), ts, body) }), body, now)).toEqual({ ok: false, reason: 'bad_signature' });
    const old = String(Number(ts) - 301);
    expect(p.verify(headers({ 'x-gf-timestamp': old, 'x-gf-signature': hmacSignature(SECRET, old, body) }), body, now)).toEqual({ ok: false, reason: 'stale_timestamp' });
    const future = String(Number(ts) + 301);
    expect(p.verify(headers({ 'x-gf-timestamp': future, 'x-gf-signature': hmacSignature(SECRET, future, body) }), body, now)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(p.verify(headers({ 'x-gf-timestamp': ts, 'x-gf-signature': 'ZZ' }), body, now)).toEqual({ ok: false, reason: 'missing_signature' });
  });
  it('parses only a strict envelope', () => {
    expect(p.parse({ deliveryId: 'd1', to: 'F_ABC@ingest.example.pe', from: 'a', text: 'b' })).toMatchObject({ deliveryId: 'd1', toLocal: 'f_abc' });
    expect(p.parse({ deliveryId: 'd1; drop', to: 'f_abc@x.pe' })).toBeNull();
    expect(p.parse({ deliveryId: 'd1', to: 'no-at-sign' })).toBeNull();
    expect(p.parse(null)).toBeNull();
  });
});
