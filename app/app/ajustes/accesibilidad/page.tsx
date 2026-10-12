import { MotionToggle, TextSizeChoice } from '../../../../components/settings-client';
import { SettingsPage, SettingsSection } from '../../../../components/settings';

export const metadata = { title: 'Accesibilidad · Ajustes' };

/** Few options, all real: text size scales the whole interface; reduced motion also follows the device setting. */
export default function AccessibilitySettings() {
  return (
    <SettingsPage title="Accesibilidad" testId="settings-accessibility">
      <SettingsSection title="Lectura y movimiento">
        <TextSizeChoice />
        <MotionToggle />
      </SettingsSection>
      <p className="muted small">Se guarda en este dispositivo.</p>
    </SettingsPage>
  );
}
