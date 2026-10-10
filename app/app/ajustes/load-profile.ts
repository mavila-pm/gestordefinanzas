import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProfileData } from './profile-view';

/** Profile for Ajustes, read under the person's session (RLS). Email and its verification come from Supabase Auth. */
export async function loadProfileData(supabase: SupabaseClient): Promise<ProfileData> {
  const [{ data: auth }, { data }] = await Promise.all([supabase.auth.getUser(), supabase.from('profiles').select('given_names,family_names,display_name,phone_e164,birth_date').maybeSingle()]);
  return {
    givenNames: (data?.given_names as string | null) ?? null, familyNames: (data?.family_names as string | null) ?? null, displayName: (data?.display_name as string | null) ?? null,
    email: auth.user?.email ?? null, emailVerified: !!auth.user?.email_confirmed_at, phone: (data?.phone_e164 as string | null) ?? null, birthDate: (data?.birth_date as string | null) ?? null,
  };
}
