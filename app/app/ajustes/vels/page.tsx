import { ActionForm } from '../../../../components/action-form';
import { SettingsPage, SettingsRow, SettingsSection } from '../../../../components/settings';
import { loadPreferences } from '../../../../lib/preferences';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { loadProfile } from '../../../../lib/queries';
import { preferredName } from '../../../../src/domain/profile';
import { VELS_STYLE_LABEL, type VelsStyle } from '../../../../src/web/preferences';
import { DisplayNameSheet } from '../profile-view';
import { savePreferencesAction } from '../actions';

export const metadata = { title: 'Vels · Ajustes' };

/** How Vels talks to you. Only the conversation changes: amounts, rules and checks are the same in every style. */
export default async function VelsSettings() {
  const supabase = await createSupabaseServerClient();
  const [prefs, profile] = await Promise.all([loadPreferences(supabase), loadProfile(supabase)]);
  const name = preferredName(profile);
  return (
    <SettingsPage title="Vels" testId="settings-vels">
      <SettingsSection title="Conversación">
        <SettingsRow label="Cómo te llama" value={<span data-testid="vels-name">{name ?? '—'}</span>} action={<DisplayNameSheet current={name} />} />
      </SettingsSection>
      <ActionForm action={savePreferencesAction} label="Preferencias de Vels" autoSubmit className="settings-section">
        <input type="hidden" name="section" value="vels" />
        <div className="settings-rows">
          <fieldset className="bare segmented settings-choice">
            <legend className="settings-row-label">Estilo de respuestas</legend>
            <div className="segments" role="radiogroup">
              {(Object.keys(VELS_STYLE_LABEL) as VelsStyle[]).map((s) => (
                <label key={s} className="segment"><input type="radio" name="velsStyle" value={s} defaultChecked={prefs.velsStyle === s} data-testid={`style-${s}`} /><span>{VELS_STYLE_LABEL[s]}</span></label>
              ))}
            </div>
            <small className="muted">{prefs.velsStyle === 'brief' ? 'Directo al punto: una o dos frases.' : prefs.velsStyle === 'detailed' ? 'Con más explicación y el desglose a la vista.' : 'Una respuesta clara con el contexto necesario.'}</small>
          </fieldset>
          <label className="settings-switch">
            <span className="settings-row-text"><span className="settings-row-label">Sugerencias proactivas</span>
              <small className="muted">Vels puede señalar cambios importantes en tus finanzas cuando los detecte.</small></span>
            <input type="checkbox" role="switch" name="velsProactive" defaultChecked={prefs.velsProactive} data-testid="proactive-switch" />
          </label>
        </div>
      </ActionForm>
      <p className="muted small">Para limpiar la conversación, usa el menú de Vels.</p>
    </SettingsPage>
  );
}
