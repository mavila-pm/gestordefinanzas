import { LIMITS, isoTimestamp, str, type FinancialEventSource } from './financial-event-source';

/**
 * Provider-agnostic inbound email payload. Each InboundEmailProvider (not chosen yet) maps its
 * webhook body to this shape after verifying the webhook signature.
 */
export interface InboundEmailPayload {
  messageId: unknown;
  from: unknown;
  subject: unknown;
  text?: unknown;
  html?: unknown;
  receivedAt: unknown;
}

export const emailBridgeSource: FinancialEventSource<InboundEmailPayload> = {
  kind: 'email_bridge',
  toRawEvent(p) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'payload must be an object' };
    const externalEventId = str(p.messageId, LIMITS.id);
    const sender = str(p.from, LIMITS.sender);
    const subject = p.subject === undefined || p.subject === '' ? '' : str(p.subject, LIMITS.subject);
    const body = str(p.text, LIMITS.body) ?? str(p.html, LIMITS.body);
    const receivedAt = isoTimestamp(p.receivedAt);
    if (!externalEventId) return { ok: false, error: 'messageId missing or too long' };
    if (!sender) return { ok: false, error: 'from missing or too long' };
    if (subject === null) return { ok: false, error: 'subject too long' };
    if (!body) return { ok: false, error: 'body missing or too large' };
    if (!receivedAt) return { ok: false, error: 'receivedAt invalid' };
    return { ok: true, event: { channel: 'email', externalEventId, sender, subject, body, receivedAt } };
  },
};
