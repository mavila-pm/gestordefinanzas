import { ActionForm } from '../../../../components/action-form';
import { SettingsPage, SettingsRow, SettingsSection } from '../../../../components/settings';
import { loadPreferences } from '../../../../lib/preferences';
import { loadCatalog } from '../../../../lib/queries';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { savePreferencesAction } from '../actions';

export const metadata = { title: 'Finanzas · Ajustes' };

/**
 * Personal defaults: they order and pre-fill, never convert. PEN and USD stay apart unless the person writes an
 * exchange; the other accounts stay exactly where they are.
 */
export default async function FinanceSettings() {
  const supabase = await createSupabaseServerClient();
  const [prefs, catalog] = await Promise.all([loadPreferences(supabase), loadCatalog(supabase)]);
  const accounts = catalog.accounts.filter((a) => a.active);
  return (
    <SettingsPage title="Finanzas" testId="settings-finance">
      <ActionForm action={savePreferencesAction} label="Preferencias financieras" autoSubmit className="settings-section">
        <input type="hidden" name="section" value="finance" />
        <h2 className="settings-section-title">Preferencias</h2>
        <div className="settings-rows">
          <fieldset className="bare segmented settings-choice">
            <legend className="settings-row-label">Moneda principal</legend>
            <div className="segments" role="radiogroup">
              <label className="segment"><input type="radio" name="primaryCurrency" value="PEN" defaultChecked={prefs.primaryCurrency === 'PEN'} data-testid="currency-PEN" /><span>PEN · Sol</span></label>
              <label className="segment"><input type="radio" name="primaryCurrency" value="USD" defaultChecked={prefs.primaryCurrency === 'USD'} data-testid="currency-USD" /><span>USD · Dólar</span></label>
            </div>
            <small className="muted">Va primero y se propone al registrar. No convierte soles y dólares.</small>
          </fieldset>
          {accounts.length > 0 ? (
            <label className="settings-choice">
              <span className="settings-row-label">Cuenta principal</span>
              <select name="primaryAccountId" defaultValue={prefs.primaryAccountId ?? ''} data-testid="primary-account">
                <option value="">Ninguna</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{[a.institution, a.alias].filter(Boolean).join(' · ')}{a.currency === 'USD' ? ' (US$)' : ''}</option>)}
              </select>
              <small className="muted">Se propone al registrar un movimiento. Tus otras cuentas siguen igual.</small>
            </label>
          ) : <input type="hidden" name="primaryAccountId" value="" />}
        </div>
      </ActionForm>
      <SettingsSection title="Tu dinero">
        <SettingsRow label="Cuentas y tarjetas" href="/app/tarjetas" />
        <SettingsRow label="Límites de gasto" href="/app/presupuestos" />
        <SettingsRow label="Meta de ahorro" href="/app/plan" />
      </SettingsSection>
    </SettingsPage>
  );
}
