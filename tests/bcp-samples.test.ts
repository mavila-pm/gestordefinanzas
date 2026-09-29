import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestRawEvent, type UserContext } from '../src/engine/ingest';
import { InMemoryTransactionRepository } from '../src/engine/repository';
import type { RawFinancialEvent } from '../src/domain/types';

const DIR = join(__dirname, 'fixtures/bcp/samples');
const CTX: UserContext = {
  userId: 'sample-user', ownAccountLast4: ['9001'],
  cards: [{ last4: '1234', kind: 'credit' }, { last4: '4821', kind: 'credit' }], merchantRules: [],
};

interface Sample {
  fixtureStatus: 'REAL_ANONYMIZED' | 'SYNTHETIC_FIXTURE';
  evidence: string;
  raw: RawFinancialEvent;
  expected: { outcome: string; transaction?: Record<string, unknown> };
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

/** Guard: fixtures must never carry sensitive data. */
const SENSITIVE = [
  { name: 'full card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'DNI', re: /\bDNI\b\D{0,5}\d{8}\b/i },
  { name: 'OTP/key', re: /\b(clave|c[óo]digo|token|OTP|CVV|PIN)\b\D{0,20}\d{3,8}\b/i },
];

describe('BCP sample bank', () => {
  it('has samples', () => expect(files.length).toBeGreaterThan(0));

  it.each(files)('%s', async (file) => {
    const content = readFileSync(join(DIR, file), 'utf8');
    for (const s of SENSITIVE) expect(s.re.test(content), `${file} contains ${s.name}`).toBe(false);

    const sample = JSON.parse(content) as Sample;
    expect(['REAL_ANONYMIZED', 'SYNTHETIC_FIXTURE']).toContain(sample.fixtureStatus);
    expect(file.includes('.real-anonymized.')).toBe(sample.fixtureStatus === 'REAL_ANONYMIZED');

    const repo = new InMemoryTransactionRepository();
    const result = await ingestRawEvent(sample.raw, CTX, repo);
    expect(result.outcome).toBe(sample.expected.outcome);
    const txs = await repo.listTransactions(CTX.userId);
    if (sample.expected.transaction) {
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject(sample.expected.transaction);
    } else {
      expect(txs).toHaveLength(0);
    }
  });
});
