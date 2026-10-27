import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export type RegistrationStep = 'password' | 'profile' | 'done';

/**
 * Where a signed-in person is in registration (migration 029, decided in SQL): a new account must create its
 * password, then complete the profile (18+, consents). Accounts created before the cutoff are 'done'.
 * On a read error pages do not lock the person out ('done'): they can read their own data, while writes stay
 * blocked because the proxy's registration gate fails closed (lib/supabase/proxy.ts). The SQL write functions do not
 * check registration themselves.
 */
export async function registrationStep(supabase: SupabaseClient): Promise<RegistrationStep> {
  const step = await registrationStatus(supabase);
  return step === 'unknown' ? 'done' : step;
}

/**
 * Same read, but a read error stays 'unknown' instead of 'done': for the email-link router (app/crear-cuenta), which
 * must not tell a brand-new account "Ya tenías una cuenta" because of a transient error.
 */
export async function registrationStatus(supabase: SupabaseClient): Promise<RegistrationStep | 'unknown'> {
  const { data, error } = await supabase.rpc('my_registration');
  const row = (Array.isArray(data) ? data[0] : data) as { required?: unknown; password_done?: unknown } | null;
  if (error || !row || typeof row.required !== 'boolean') return 'unknown';
  if (!row.required) return 'done';
  return row.password_done ? 'profile' : 'password';
}
