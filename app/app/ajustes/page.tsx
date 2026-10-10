import { logout } from '../../auth/actions';
import { SettingsNav } from '../../../components/settings-client';
import { Avatar } from '../../../components/settings';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { preferredName } from '../../../src/domain/profile';
import { loadProfileData } from './load-profile';
import { maskEmail, ProfileView } from './profile-view';

export const metadata = { title: 'Ajustes' };

/** Mobile: the list of sections (each opens its own screen). Desktop: the sidebar is in the layout; Perfil shows here. */
export default async function Settings() {
  const supabase = await createSupabaseServerClient();
  const p = await loadProfileData(supabase);
  const name = preferredName(p);
  return (
    <main className="stack" id="main" data-testid="settings">
      <div className="settings-mobile-only stack-sm">
        <h1>Ajustes</h1>
        <div className="row card" style={{ justifyContent: 'flex-start', gap: 12, padding: 16 }}>
          <Avatar name={name} size={44} />
          <div><strong>{name ?? 'Tu cuenta'}</strong>{p.email && <p className="muted small">{maskEmail(p.email)}</p>}</div>
        </div>
        <SettingsNav variant="list" />
        <form action={logout}><button type="submit" className="link" style={{ paddingLeft: 0 }}>Cerrar sesión</button></form>
      </div>
      <div className="settings-desktop-only stack">
        <h1>Perfil</h1>
        <ProfileView p={p} />
      </div>
    </main>
  );
}
