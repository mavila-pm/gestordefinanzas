import { beforeEach, describe, expect, it } from 'vitest';
import { ingestRawEvent, OWN_TRANSFER_WINDOW_MIN, type UserContext } from '../src/engine/ingest';
import { InMemoryTransactionRepository } from '../src/engine/repository';
import { monthlySummary } from '../src/engine/monthly-summary';
import { parseIngestionCodes, reviewReasons } from '../src/engine/review-reasons';
import * as bcp from './fixtures/bcp';
import * as bbva from './fixtures/bbva';

/** Possible own transfer across banks: a suggestion for the person, never an automatic change. */
const CTX: UserContext = { userId: 'u', ownAccountLast4: ['9001'], cards: [], merchantRules: [] };
// The BCP transfer fixtures happen at 10/09/2026 10:00 (Lima) for S/ 500.00.
const bbvaDeposit = (amount = 'S/ 500.00', time = '10:05') => bbva.bbvaSms(`BBVA: Abono recibido de ${amount} en tu cuenta el 10/09/2026 ${time}.`);

let repo: InMemoryTransactionRepository;
beforeEach(() => { repo = new InMemoryTransactionRepository(); });

const deposit = async () => (await repo.listTransactions('u')).find((t) => t.type === 'deposit')!;

describe('possible own transfer across banks', () => {
  it('BCP transfer to an unknown account + BBVA deposit, same amount 5 min later -> deposit flagged, type kept, review', async () => {
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, repo);
    const r = await ingestRawEvent(bbvaDeposit(), CTX, repo);
    expect(r.outcome).toBe('created');
    expect(parseIngestionCodes(r.detail)).toContain('possible_own_transfer');
    expect(await deposit()).toMatchObject({ type: 'deposit', direction: 'inflow', status: 'review_required', institution: 'BBVA', amountMinor: 50000 });
    // The transfer itself is untouched.
    expect((await repo.listTransactions('u')).find((t) => t.institution === 'BCP')).toMatchObject({ type: 'unknown', direction: 'outflow' });
  });

  it('an internal transfer (to a registered own account) also counts as a match', async () => {
    await ingestRawEvent(bcp.transferEmail('9001'), CTX, repo);
    const r = await ingestRawEvent(bbvaDeposit(), CTX, repo);
    expect(parseIngestionCodes(r.detail)).toContain('possible_own_transfer');
  });

  it('the reason is explained in plain language and suggests the correction', async () => {
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, repo);
    const r = await ingestRawEvent(bbvaDeposit(), CTX, repo);
    const reasons = reviewReasons(await deposit(), { ingestionCodes: parseIngestionCodes(r.detail), registeredCardLast4: [], cardId: null });
    expect(reasons.find((x) => x.code === 'possible_own_transfer')?.text).toMatch(/otro banco.*Transferencia entre mis cuentas/);
  });

  it('PEN never matches USD', async () => {
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, repo);
    const r = await ingestRawEvent(bbvaDeposit('US$ 500.00'), CTX, repo);
    expect(parseIngestionCodes(r.detail)).not.toContain('possible_own_transfer');
  });

  it(`window is ±${OWN_TRANSFER_WINDOW_MIN} min (inclusive); later or a different amount is not a match`, async () => {
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, repo);
    expect(parseIngestionCodes((await ingestRawEvent(bbvaDeposit('S/ 500.00', '10:30'), CTX, repo)).detail)).toContain('possible_own_transfer');
    const other = new InMemoryTransactionRepository();
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, other);
    expect(parseIngestionCodes((await ingestRawEvent(bbvaDeposit('S/ 500.00', '10:31'), CTX, other)).detail)).not.toContain('possible_own_transfer');
    const third = new InMemoryTransactionRepository();
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, third);
    expect(parseIngestionCodes((await ingestRawEvent(bbvaDeposit('S/ 499.00'), CTX, third)).detail)).not.toContain('possible_own_transfer');
  });

  it('a deposit at the SAME bank, a purchase of the same amount, or an ignored transfer are not matches', async () => {
    await ingestRawEvent(bbva.transferEmail('7777'), CTX, repo); // BBVA transfer 10:00, S/ 500.00
    expect(parseIngestionCodes((await ingestRawEvent(bbvaDeposit(), CTX, repo)).detail)).not.toContain('possible_own_transfer');

    const purchases = new InMemoryTransactionRepository();
    await ingestRawEvent(bcp.bcpSms('BCP: Realizaste un consumo de S/ 500.00 con tu Tarjeta de Credito *4821 en TIENDA el 10/09/2026 10:00.'), CTX, purchases);
    expect(parseIngestionCodes((await ingestRawEvent(bbvaDeposit(), CTX, purchases)).detail)).not.toContain('possible_own_transfer');

    class WithIgnored extends InMemoryTransactionRepository {
      override async findCandidates(q: Parameters<InMemoryTransactionRepository['findCandidates']>[0]) {
        return (await super.findCandidates(q)).map((t) => ({ ...t, status: 'ignored' as const }));
      }
    }
    const ignored = new WithIgnored();
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, ignored);
    expect(parseIngestionCodes((await ingestRawEvent(bbvaDeposit(), CTX, ignored)).detail)).not.toContain('possible_own_transfer');
  });

  it('suggestion only: nothing counts as income until the person decides', async () => {
    await ingestRawEvent(bcp.transferEmail('7777'), CTX, repo);
    await ingestRawEvent(bbvaDeposit(), CTX, repo);
    expect(monthlySummary(await repo.listTransactions('u'), '2026-09', 'PEN')).toMatchObject({ incomeMinor: 0, expensesMinor: 0, savingsLabel: 'estimated' });
  });
});
