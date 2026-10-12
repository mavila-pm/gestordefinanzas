import { ActionForm } from '../../../../components/action-form';
import { SettingsPage, SettingsRow, SettingsSection } from '../../../../components/settings';
import { loadPreferences } from '../../../../lib/preferences';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { savePreferencesAction } from '../actions';

export const metadata = { title: 'Notificaciones · Ajustes' };

const NOTICES = [
  ['notifyUpcoming', 'Próximos pagos', 'Recibe un aviso antes de tus pagos.'],
  ['notifyReview', 'Por revisar', 'Te avisamos cuando algo necesite tu confirmación.'],
  ['notifyMonthly', 'Resumen mensual', 'Recibe un resumen cuando termine el mes.'],
  ['notifyLimits', 'Límites de gasto', 'Te avisamos cuando te acerques a uno de tus límites.'],
] as const;

/** Notices shown inside Velsuno (the only channel that exists today). Security notices are never turned off. */
export default async function NotificationSettings() {
  const prefs = await loadPreferences(await createSupabaseServerClient());
  return (
    <SettingsPage title="Notificaciones" testId="settings-notifications">
      <ActionForm action={savePreferencesAction} label="Notificaciones" autoSubmit className="settings-section">
        <input type="hidden" name="section" value="notifications" />
        <h2 className="settings-section-title">Avisos</h2>
        <div className="settings-rows">
          {NOTICES.map(([key, label, hint]) => (
            <label key={key} className="settings-switch">
              <span className="settings-row-text"><span className="settings-row-label">{label}</span><small className="muted">{hint}</small></span>
              <input type="checkbox" role="switch" name={key} defaultChecked={prefs[key]} data-testid={`notice-${key}`} />
            </label>
          ))}
        </div>
      </ActionForm>
      <SettingsSection title="Dónde">
        <SettingsRow label="En Velsuno" value="Activado" hint="En tu Resumen y al abrir Vels." />
      </SettingsSection>
    </SettingsPage>
  );
}
