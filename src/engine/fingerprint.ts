import { createHash } from 'node:crypto';
import type { NormalizedFinancialEvent } from '../domain/types';

/** Level-2 financial fingerprint: same money fact regardless of the channel that reported it. */
export function financialFingerprint(userId: string, e: NormalizedFinancialEvent): string {
  const minute = e.occurredAt.slice(0, 16);
  const key = [userId, e.institution, e.type, e.amountMinor, e.currency, e.cardLast4 ?? '-', minute].join('|');
  return createHash('sha256').update(key).digest('hex');
}
