import { ActionForm } from '../../../../components/action-form';
import { ChangePasswordForm } from '../../../../components/change-password-form';
import { SettingsPage, SettingsRow, SettingsSection } from '../../../../components/settings';
import { Sheet } from '../../../../components/ui/sheet';
import { logout } from '../../../auth/actions';
import { signOutOthersAction } from '../actions';

export const metadata = { title: 'Seguridad · Ajustes' };

/** Real controls only: password, how you sign in, and closing the other sessions. */
export default function SecuritySettings() {
  return (
    <SettingsPage title="Seguridad" testId="settings-security">
      <SettingsSection title="Acceso">
        <SettingsRow label="Contraseña" action={
          <Sheet label="Cambiar contraseña" triggerClassName="link small-link" title="Cambiar contraseña" testId="password-sheet">
            <div className="sheet-body"><ChangePasswordForm /></div>
          </Sheet>} />
        <SettingsRow label="Métodos de acceso" value="Correo y contraseña" />
      </SettingsSection>
      <SettingsSection title="Sesiones">
        <div className="settings-row">
          <span className="settings-row-text"><span className="settings-row-label">Otros dispositivos</span><small className="muted">Cierra la sesión en todos los demás. Este sigue abierto.</small></span>
          <ActionForm action={signOutOthersAction} label="Cerrar otras sesiones" className="inline">
            <button type="submit" className="quiet" data-testid="signout-others">Cerrar otras sesiones</button>
          </ActionForm>
        </div>
        <form action={logout} className="settings-row"><button type="submit" className="link" style={{ paddingLeft: 0 }}>Cerrar sesión</button></form>
      </SettingsSection>
    </SettingsPage>
  );
}
