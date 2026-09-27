import type { BankAdapter } from './bank-adapter';
import type { RawFinancialEvent } from '../domain/types';
import { bcpEmailV1 } from './adapters/bcp/bcp-email-v1';
import { bcpSmsV1 } from './adapters/bcp/bcp-sms-v1';

/** The only place that knows which banks exist. New banks/versions are registered here. */
export class AdapterRegistry {
  constructor(private readonly adapters: readonly BankAdapter[]) {}

  resolve(raw: RawFinancialEvent): BankAdapter | null {
    return this.adapters.find((a) => a.canHandle(raw)) ?? null;
  }
}

export const bcpAdapters: readonly BankAdapter[] = [bcpEmailV1, bcpSmsV1];

export const defaultAdapterRegistry = new AdapterRegistry([...bcpAdapters]);
