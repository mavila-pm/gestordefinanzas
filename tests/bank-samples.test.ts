import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestRawEvent, type IngestOptions, type UserContext } from '../src/engine/ingest';
import { InMemoryTransactionRepository } from '../src/engine/repository';
import { registeredAdapters } from '../src/ingestion/adapter-registry';
import type { BankAdapter } from '../src/ingestion/bank-adapter';
import type { RawFinancialEvent } from '../src/domain/types';

/**
 * Golden samples of every bank: tests/fixtures/<bank>/samples/<channel>-<case>.(real-anonymized|synthetic).json,
 * each run through the full pipeline with the default registry.
 */
const ROOT = join(__dirname, 'fixtures');
const BANK_DIRS = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'samples')))
  .map((d) => d.name)
  .sort();

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

const samples = BANK_DIRS.flatMap((bank) => readdirSync(join(ROOT, bank, 'samples'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ bank, file, path: join(ROOT, bank, 'samples', file) })));

/**
 * The options production uses for this source: pasted text goes through the import path; anything else is a
 * delivered notification (Email Bridge, Android SMS), which never auto-confirms an unverified template. So the
 * statuses pinned by the samples are the statuses a person would really see.
 */
export function productionOptions(raw: RawFinancialEvent): IngestOptions {
  return raw.sender.startsWith('user-import:') ? { persistAs: 'import' } : { requireVerifiedTemplate: true };
}

/** Guard: fixtures must never carry sensitive data. */
const SENSITIVE = [
  { name: 'full card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'DNI', re: /\bDNI\b\D{0,5}\d{8}\b/i },
  { name: 'OTP/key', re: /\b(clave|c[óo]digo|token|OTP|CVV|PIN)\b\D{0,20}\d{3,8}\b/i },
];

/** parserVersions with at least one REAL_ANONYMIZED sample that created a movement. */
async function realCreatedParserVersions(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const s of samples) {
    const sample = JSON.parse(readFileSync(s.path, 'utf8')) as Sample;
    if (sample.fixtureStatus !== 'REAL_ANONYMIZED' || sample.expected.outcome !== 'created') continue;
    const repo = new InMemoryTransactionRepository();
    const r = await ingestRawEvent(sample.raw, CTX, repo, undefined, productionOptions(sample.raw));
    if (r.outcome !== 'created') continue;
    for (const t of await repo.listTransactions(CTX.userId)) for (const src of t.sources) out.add(src.parserVersion);
  }
  return out;
}

/** parserVersions that read (any outcome) at least one REAL_ANONYMIZED sample. */
async function realRoutedParserVersions(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const s of samples) {
    const sample = JSON.parse(readFileSync(s.path, 'utf8')) as Sample;
    if (sample.fixtureStatus !== 'REAL_ANONYMIZED') continue;
    const repo = new InMemoryTransactionRepository();
    await ingestRawEvent(sample.raw, CTX, repo, undefined, productionOptions(sample.raw));
    for (const e of repo.events) if (e.parserVersion) out.add(e.parserVersion);
  }
  return out;
}

/** An adapter may claim VERIFIED only when a real anonymized sample proves it creates movements. */
export function verifiedWithoutRealSample(adapters: readonly BankAdapter[], realCreated: ReadonlySet<string>): string[] {
  return adapters.filter((a) => a.templateVerification === 'VERIFIED' && !realCreated.has(a.parserVersion)).map((a) => a.parserVersion);
}

/** An adapter may claim `observed` (its bank named as read in the UI) only when a real sample routes to it. */
export function observedWithoutRealSample(adapters: readonly BankAdapter[], realRouted: ReadonlySet<string>): string[] {
  return adapters.filter((a) => a.observed && !realRouted.has(a.parserVersion)).map((a) => a.parserVersion);
}

describe('bank sample bank (all banks)', () => {
  it('has samples for BCP and BBVA', () => {
    expect(BANK_DIRS).toEqual(expect.arrayContaining(['bcp', 'bbva']));
    for (const bank of ['bcp', 'bbva']) expect(samples.filter((s) => s.bank === bank).length).toBeGreaterThan(0);
  });

  it.each(samples.map((s) => [`${s.bank}/${s.file}`, s] as const))('%s', async (_name, s) => {
    expect(s.file).toMatch(/^(email|sms|push)-[a-z0-9-]+\.(real-anonymized|synthetic)\.json$/);
    const content = readFileSync(s.path, 'utf8');
    for (const g of SENSITIVE) expect(g.re.test(content), `${s.file} contains ${g.name}`).toBe(false);

    const sample = JSON.parse(content) as Sample;
    expect(['REAL_ANONYMIZED', 'SYNTHETIC_FIXTURE']).toContain(sample.fixtureStatus);
    expect(s.file.includes('.real-anonymized.')).toBe(sample.fixtureStatus === 'REAL_ANONYMIZED');

    const repo = new InMemoryTransactionRepository();
    const result = await ingestRawEvent(sample.raw, CTX, repo, undefined, productionOptions(sample.raw));
    expect(result.outcome).toBe(sample.expected.outcome);
    // Routed to the bank whose folder it lives in (only "not financial" has no parser; ambiguity is never a sample).
    const version = repo.events[0]?.parserVersion ?? null;
    if (sample.expected.outcome === 'not_financial') expect(version).toBeNull();
    else expect(version?.startsWith(`${s.bank.toUpperCase()}_`), `${s.file} parsed by ${version}`).toBe(true);
    const txs = await repo.listTransactions(CTX.userId);
    if (sample.expected.transaction) {
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject(sample.expected.transaction);
      expect(txs[0]!.institution).toBe(s.bank.toUpperCase());
    } else {
      expect(txs).toHaveLength(0);
    }
  });
});

describe('VERIFIED needs real evidence', () => {
  it('every adapter marked VERIFIED has >= 1 REAL_ANONYMIZED sample that created a movement with its parserVersion', async () => {
    expect(verifiedWithoutRealSample(registeredAdapters, await realCreatedParserVersions())).toEqual([]);
  });

  it('the guard rejects a VERIFIED adapter without such a sample', () => {
    const fake = { ...registeredAdapters[0]!, parserVersion: 'FAKE_V1', templateVerification: 'VERIFIED' as const };
    expect(verifiedWithoutRealSample([fake], new Set())).toEqual(['FAKE_V1']);
    expect(verifiedWithoutRealSample([fake], new Set(['FAKE_V1']))).toEqual([]);
  });

  it('every adapter marked observed has >= 1 REAL_ANONYMIZED sample routed to its parserVersion', async () => {
    expect(observedWithoutRealSample(registeredAdapters, await realRoutedParserVersions())).toEqual([]);
    const fake = { ...registeredAdapters[0]!, parserVersion: 'FAKE_V1', observed: true };
    expect(observedWithoutRealSample([fake], new Set())).toEqual(['FAKE_V1']);
  });

  it('today no adapter is VERIFIED (all templates are synthetic until real samples arrive)', () => {
    expect(registeredAdapters.filter((a) => a.templateVerification === 'VERIFIED')).toEqual([]);
  });
});
