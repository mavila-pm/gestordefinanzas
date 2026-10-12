import { ModeChoice } from '../../../../components/settings-client';
import { SettingsPage, SettingsRow, SettingsSection } from '../../../../components/settings';

export const metadata = { title: 'Apariencia · Ajustes' };

/**
 * Only what the design system really has: light and dark (Marfil / Grafito) and one accent (Cítrico). Saved on this
 * device and applied before the page paints.
 */
export default function AppearanceSettings() {
  return (
    <SettingsPage title="Apariencia" testId="settings-appearance">
      <SettingsSection title="Pantalla">
        <ModeChoice />
        <SettingsRow label="Tema" value="Velsuno" hint="Marfil en claro, Grafito en oscuro." />
        <SettingsRow label="Acento" value={<><i className="swatch citrico" aria-hidden="true" />Cítrico</>} />
      </SettingsSection>
      <p className="muted small">Se guarda en este dispositivo.</p>
    </SettingsPage>
  );
}
