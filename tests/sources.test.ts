import { describe, expect, it } from 'vitest';
import { emailBridgeSource } from '../src/ingestion/sources/email-bridge-source';
import { androidSmsSource } from '../src/ingestion/sources/android-sms-source';

const validEmail = {
  messageId: '<m1@mail.test>', from: 'notificaciones@notificacionesbcp.com.pe',
  subject: 'Asunto', text: 'cuerpo', receivedAt: '2026-09-20T18:06:00Z',
};

describe('EmailBridgeSource (provider-agnostic)', () => {
  it('maps a valid payload to a RawFinancialEvent', () => {
    expect(emailBridgeSource.toRawEvent(validEmail)).toEqual({
      ok: true,
      event: { channel: 'email', externalEventId: '<m1@mail.test>', sender: validEmail.from, subject: 'Asunto', body: 'cuerpo', receivedAt: '2026-09-20T18:06:00.000Z' },
    });
  });

  it.each([
    ['null payload', null],
    ['missing messageId', { ...validEmail, messageId: undefined }],
    ['non-string from', { ...validEmail, from: { $gt: '' } }],
    ['bad date', { ...validEmail, receivedAt: 'ayer' }],
    ['oversized body', { ...validEmail, text: 'x'.repeat(64 * 1024 + 1) }],
    ['no body', { ...validEmail, text: undefined }],
  ])('rejects %s', (_n, payload) => {
    expect(emailBridgeSource.toRawEvent(payload as never).ok).toBe(false);
  });
});

describe('AndroidSmsSource', () => {
  it('maps a valid SMS without device id (content hash is used later)', () => {
    const r = androidSmsSource.toRawEvent({ sender: '19896', body: 'BCP Alertas: ...', receivedAt: '2026-09-20T18:06:00Z' });
    expect(r).toMatchObject({ ok: true, event: { channel: 'sms', sender: '19896' } });
    expect(r.ok && r.event.externalEventId).toBeFalsy();
  });

  it('rejects OTP messages even if the device filter failed', () => {
    const r = androidSmsSource.toRawEvent({ sender: '19896', body: 'BCP: Tu clave digital es 482913. No la compartas.', receivedAt: '2026-09-20T18:06:00Z' });
    expect(r).toEqual({ ok: false, error: 'otp_message_rejected' });
  });

  it('rejects invalid payloads', () => {
    expect(androidSmsSource.toRawEvent({ sender: '', body: 'x', receivedAt: '2026-09-20T18:06:00Z' }).ok).toBe(false);
    expect(androidSmsSource.toRawEvent({ sender: '19896', body: 'x'.repeat(2001), receivedAt: '2026-09-20T18:06:00Z' }).ok).toBe(false);
  });
});
