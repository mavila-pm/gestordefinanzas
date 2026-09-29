import { LIMITS, isoTimestamp, str, type FinancialEventSource } from './financial-event-source';

/**
 * Payload uploaded by the (future) Android app. The app filters locally: only SMS from known
 * bank senders are sent, never personal conversations or OTPs.
 */
export interface AndroidSmsPayload {
  sender: unknown;
  body: unknown;
  receivedAt: unknown;
  /** Optional device-side id; when absent the content hash is used for idempotency. */
  deviceMessageId?: unknown;
}

const SMS_MAX = 2000;
/** Server-side guard in case the device filter fails: never keep OTP messages. */
const OTP_RE = /\b(clave|c[óo]digo|token|OTP)\b[^.]{0,40}\b\d{4,8}\b/i;

export const androidSmsSource: FinancialEventSource<AndroidSmsPayload> = {
  kind: 'android_sms',
  toRawEvent(p) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'payload must be an object' };
    const sender = str(p.sender, 32);
    const body = str(p.body, SMS_MAX);
    const receivedAt = isoTimestamp(p.receivedAt);
    const id = p.deviceMessageId === undefined ? undefined : str(p.deviceMessageId, LIMITS.id);
    if (!sender) return { ok: false, error: 'sender missing or too long' };
    if (!body) return { ok: false, error: 'body missing or too large' };
    if (!receivedAt) return { ok: false, error: 'receivedAt invalid' };
    if (id === null) return { ok: false, error: 'deviceMessageId invalid' };
    if (OTP_RE.test(body)) return { ok: false, error: 'otp_message_rejected' };
    return { ok: true, event: { channel: 'sms', sender, body, receivedAt, ...(id ? { externalEventId: id } : {}) } };
  },
};
