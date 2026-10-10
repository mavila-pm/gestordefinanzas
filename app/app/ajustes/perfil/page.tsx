import { SettingsPage } from '../../../../components/settings';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { loadProfileData } from '../load-profile';
import { ProfileView } from '../profile-view';

export const metadata = { title: 'Perfil · Ajustes' };

export default async function ProfileSettings() {
  const p = await loadProfileData(await createSupabaseServerClient());
  return <SettingsPage title="Perfil" testId="settings-profile"><ProfileView p={p} /></SettingsPage>;
}
