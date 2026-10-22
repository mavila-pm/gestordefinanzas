import { SettingsPage, SettingsRow, SettingsSection } from '../../../../components/settings';
import { supportEmail } from '../../../../components/legal-page';

export const metadata = { title: 'Privacidad y datos · Ajustes' };

/** What happens with your data, and what you can do with it today (no promises of features that do not exist). */
export default function PrivacySettings() {
  const email = supportEmail();
  return (
    <SettingsPage title="Privacidad y datos" testId="settings-privacy">
      <SettingsSection title="Documentos">
        <SettingsRow label="Política de privacidad" href="/privacidad" />
        <SettingsRow label="Términos y condiciones" href="/terminos" />
      </SettingsSection>
      <SettingsSection title="Tus datos">
        <a href="/app/exportar?month=all" className="settings-row link-row" data-testid="download-data">
          <span className="settings-row-text"><span className="settings-row-label">Descargar mis movimientos</span><small className="muted">Archivo CSV para Excel, con todo tu historial.</small></span>
        </a>
        <SettingsRow label="Eliminar mi cuenta" hint={email ? <>Escríbenos a <a href={`mailto:${email}?subject=Eliminar%20mi%20cuenta`}>{email}</a> y la eliminamos con todos tus datos.</> : 'Escríbenos desde el correo de tu cuenta y la eliminamos con todos tus datos.'} />
      </SettingsSection>
    </SettingsPage>
  );
}
