import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export type RegistrationStep = 'password' | 'profile' | 'done';

/**
 * Where a signed-in person is in registration (migration 029, decided in SQL): a new account must create its
 * password, then complete the profile (18+, consents). Accounts created before the cutoff are 'done'.
 * On a read error the app does not lock the person out ('done'); the steps are enforced again by the SQL functions.
 */
export async function registrationStep(supabase: SupabaseClient): Promise<RegistrationStep> {
  const { data, error } = await supabase.rpc('my_registration');
  const row = (Array.isArray(data) ? data[0] : data) as { required: boolean; password_done: boolean } | null;
  if (error || !row || !row.required) return 'done';
  return row.password_done ? 'profile' : 'password';
}
