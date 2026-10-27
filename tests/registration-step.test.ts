import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * lib/registration.ts: the registration step read from SQL (my_registration). Pages treat an unreadable step as
 * 'done' (writes stay blocked by the proxy gate); the email-link router keeps it 'unknown' so a new account is never
 * told "Ya tenías una cuenta" because of a transient error. Supabase is a stub.
 */
vi.mock('server-only', () => ({}));

const client = (answer: { data: unknown; error: unknown }) => ({ rpc: vi.fn(async () => answer) }) as unknown as SupabaseClient;

describe('registrationStatus / registrationStep', () => {
  it('steps come from my_registration', async () => {
    const { registrationStatus } = await import('../lib/registration');
    expect(await registrationStatus(client({ data: [{ required: true, password_done: false }], error: null }))).toBe('password');
    expect(await registrationStatus(client({ data: [{ required: true, password_done: true }], error: null }))).toBe('profile');
    expect(await registrationStatus(client({ data: [{ required: false, password_done: true }], error: null }))).toBe('done');
  });

  it('read error, no row or a malformed row → unknown for the router, done for pages', async () => {
    const { registrationStatus, registrationStep } = await import('../lib/registration');
    for (const answer of [{ data: null, error: { code: 'PGRST301' } }, { data: [], error: null }, { data: [{ required: 'no' }], error: null }]) {
      expect(await registrationStatus(client(answer))).toBe('unknown');
      expect(await registrationStep(client(answer))).toBe('done');
    }
  });
});
