import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { ProfileFields } from '../../../components/profile-fields';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { ThemeControl } from '../../../components/ui/theme-control';
import { loadProfile } from '../../../lib/queries';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { shortFullName } from '../../../src/domain/profile';
import { logout } from '../../auth/actions';
import { saveProfileAction } from '../actions';

export const metadata = { title: 'Ajustes' };

export default async function Settings() {
  const supabase = await createSupabaseServerClient();
  const [profile, user] = await Promise.all([loadProfile(supabase), authUser(supabase)]);
  const name = shortFullName(profile);
  return (
    <main className="stack narrow-md">
      <h1>Ajustes</h1>

      <section className="group" aria-labelledby="g-profile">
        <h2 id="g-profile" className="group-title">Perfil</h2>
        <div className="rows">
          <div className="setting">
            <span className="setting-text">
              <strong data-testid="profile-name">{name ?? 'Aún no nos dijiste tu nombre'}</strong>
              <small className="muted">{user?.email}</small>
            </span>
            <Sheet label="Editar" triggerClassName="link" title="Tus datos" testId="profile-sheet" triggerLabel="Editar perfil">
              <div className="sheet-body">
                <ActionForm action={saveProfileAction} label="Perfil">
                  <ProfileFields givenNames={profile.givenNames ?? ''} familyNames={profile.familyNames ?? ''} displayName={profile.displayName ?? ''} />
                  <small className="muted">Te llamamos por el último campo. Tus nombres completos se guardan tal cual.</small>
                  <button type="submit" className="wide">Guardar</button>
                </ActionForm>
              </div>
            </Sheet>
          </div>
        </div>
      </section>

      <section className="group" aria-labelledby="g-look">
        <h2 id="g-look" className="group-title">Apariencia</h2>
        <div className="rows"><div className="setting"><ThemeControl hideLegend /></div></div>
      </section>

      <section className="group" aria-labelledby="g-data">
        <h2 id="g-data" className="group-title">Datos</h2>
        <div className="rows">
          <a href="/app/exportar?month=all" className="setting link-row">
            <span className="setting-text"><strong>Descargar mis movimientos</strong><small className="muted">Archivo CSV para Excel</small></span>
            <Icon name="chevron" size={18} />
          </a>
        </div>
      </section>

      <section className="group" aria-labelledby="g-account">
        <h2 id="g-account" className="group-title">Cuenta</h2>
        <div className="rows">
          <Link href="/app/cuenta" className="setting link-row">
            <span className="setting-text"><strong>Plan</strong></span>
            <Icon name="chevron" size={18} />
          </Link>
          <form action={logout} className="setting"><button type="submit" className="link" style={{ paddingLeft: 0 }}>Cerrar sesión</button></form>
        </div>
      </section>
    </main>
  );
}
