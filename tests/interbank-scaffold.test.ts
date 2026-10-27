import { describe, expect, it } from 'vitest';
import { interbankEmailV1, interbankSmsV1 } from '../src/ingestion/adapters/interbank/interbank-scaffold';
import { bcpEmailV1 } from '../src/ingestion/adapters/bcp/bcp-email-v1';
import { defaultAdapterRegistry } from '../src/ingestion/adapter-registry';
import { toPlainText } from '../src/ingestion/sanitize';
import { ingestRawEvent, type UserContext } from '../src/engine/ingest';
import { InMemoryTransactionRepository } from '../src/engine/repository';
import type { RawFinancialEvent } from '../src/domain/types';
import * as bcp from './fixtures/bcp';

/** SYNTHETIC_FIXTURE: invented Interbank-looking messages (no Interbank message has been observed). */
const CTX: UserContext = { userId: 'u', ownAccountLast4: [], cards: [], merchantRules: [] };
const interbankEmail = (): RawFinancialEvent => ({
  channel: 'email', externalEventId: '<ib-1@interbank.test>', sender: 'Interbank <avisos@interbank-sintetico.example>',
  subject: 'Consumo con tu tarjeta Interbank',
  body: 'Hola, CLIENTE DE PRUEBA\nConsumo aprobado.\nMonto: S/ 100.00\nTambién puedes pagar tus tarjetas en agentes BCP.\nInterbank (texto sintético de prueba)',
  receivedAt: '2026-09-16T01:31:00Z',
});

describe('Interbank scaffold (zero templates)', () => {
  it('claims only messages naming Interbank; never verifies a sender; never reads a movement', () => {
    for (const a of [interbankEmailV1, interbankSmsV1]) {
      expect(a).toMatchObject({ institution: 'INTERBANK', scaffold: true, templateVerification: 'SYNTHETIC_UNVERIFIED' });
    }
    const raw = interbankEmail();
    expect(interbankEmailV1.canHandle(raw)).toBe(true);
    expect(interbankEmailV1.verifySource(raw)).toBe(false);
    expect(interbankEmailV1.parse(raw, toPlainText(raw.body))).toMatchObject({ ok: false, reason: 'unknown_template' });
    expect(interbankEmailV1.canHandle(bcp.purchasePenEmail())).toBe(false);
  });

  it('an Interbank email that mentions BCP in its footer resolves to Interbank -> unresolved, 0 transactions', async () => {
    const raw = interbankEmail();
    expect(bcpEmailV1.canHandle(raw)).toBe(true); // the old first-match routing sent it to BCP
    expect(defaultAdapterRegistry.parse(raw, toPlainText(raw.body))).toMatchObject({ ok: false, reason: 'unknown_template', parserVersion: 'INTERBANK_EMAIL_V1' });
    const repo = new InMemoryTransactionRepository();
    const r = await ingestRawEvent(raw, CTX, repo);
    expect(r).toMatchObject({ outcome: 'unresolved', transactionId: null });
    expect(await repo.listTransactions('u')).toHaveLength(0);
    expect(repo.events[0]).toMatchObject({ outcome: 'unresolved', parserVersion: 'INTERBANK_EMAIL_V1' });
  });

  it('an Interbank SMS is unresolved too', async () => {
    const raw: RawFinancialEvent = { channel: 'sms', sender: 'user-import:sms', body: 'Interbank: Consumo de S/ 25.00 con tu tarjeta *1111 en TAMBO el 15/09/2026 20:30.', receivedAt: '2026-09-16T01:31:00Z' };
    const repo = new InMemoryTransactionRepository();
    expect((await ingestRawEvent(raw, CTX, repo, undefined, { persistAs: 'import' })).outcome).toBe('unresolved');
    expect(await repo.listTransactions('u')).toHaveLength(0);
  });

  it('a BCP message that mentions Interbank is still read by BCP', () => {
    const raw = bcp.transferEmail('7788');
    raw.body += '\nTransferencias interbancarias a Interbank en minutos.';
    expect(defaultAdapterRegistry.parse(raw, toPlainText(raw.body))).toMatchObject({ ok: true, event: { institution: 'BCP' } });
  });
});
