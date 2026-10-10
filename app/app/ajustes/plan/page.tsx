import { ActionForm } from '../../../../components/action-form';
import { SettingsPage, SettingsRow, SettingsSection, UsageMeter } from '../../../../components/settings';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { loadEntitlements } from '../../../../lib/queries';
import { aiPlanFrom, allowance, velsUsage, type AIPlan } from '../../../../src/ai/entitlements';
import { longDate } from '../../../../src/domain/dates';
import { formatLimaDateTime } from '../../../../src/web/transaction-input';
import { limaMonth, limaMonthRange } from '../../../../src/web/auth-input';
import { startTrialAction } from '../../actions';
import { resetDemoOnboardingAction, setDemoPlanAction } from '../demo-actions';

const PLAN_NAME: Record<AIPlan, string> = { free: 'Free', trial: 'Prueba Plus', plus: 'Plus' };

export const metadata = { title: 'Plan y uso · Ajustes' };

/**
 * Plan y uso: the plan, how much of Vels is used and when it renews, and the limits that matter. Everything from
 * real rows (subscriptions, ai_usage, plan_config) — the database enforces; this only shows. Never raw tokens.
 */
export default async function PlanSettings() {
  const supabase = await createSupabaseServerClient();
  const range = limaMonthRange(limaMonth())!;
  const [{ entitlements: e, config }, auto, usage, cfg, sub, demo, onb] = await Promise.all([
    loadEntitlements(supabase),
    supabase.from('transaction_sources').select('id', { count: 'exact', head: true }).in('channel', ['email', 'sms', 'import']).gte('received_at', range.from).lt('received_at', range.to),
    supabase.from('ai_usage').select('bucket,weighted_tokens,camera_reads'),
    supabase.from('plan_config').select('key,value').like('key', 'ai_%'),
    supabase.from('subscriptions').select('plan,status,trial_ends_at,current_period_end').maybeSingle(),
    supabase.from('demo_access').select('simulated_plan').maybeSingle(),
    supabase.from('onboarding_states').select('status').maybeSingle(),
  ]);
  const now = new Date();
  const simulated = (demo.data?.simulated_plan ?? null) as AIPlan | null;
  const plan = aiPlanFrom(sub.data, simulated, now);
  const ai = allowance(plan, !!simulated, Object.fromEntries((cfg.data ?? []).map((r) => [r.key, Number(r.value)])), usage.data ?? [], onb.data?.status === 'active', now);
  const meter = velsUsage(ai, now, sub.data?.trial_ends_at ?? null);
  const plus = e.plan === 'plus';
  const limit = e.limits.autoMovementsPerMonth;
  const resetLabel = meter.resetAt ? (meter.renews === 'trial_end' ? `Tu prueba termina el ${longDate(meter.resetAt)}.` : `Se reinicia el ${longDate(meter.resetAt)}. Tu uso se renueva automáticamente cada mes.`) : null;

  return (
    <SettingsPage title="Plan y uso" testId="settings-plan">
      <SettingsSection title="Plan actual" testId="plan">
        <div className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-label" data-testid="plan-name" style={{ fontSize: 20 }}>{plus ? 'Plus' : 'Free'}{e.source === 'trial' ? ' · prueba' : ''}</span>
            <small className="muted">{plus ? 'Todo Velsuno, con más uso de Vels e historial completo.' : 'Las herramientas esenciales para organizar tu dinero.'}</small>
          </span>
          {simulated && <span className="tag">Simulación {PLAN_NAME[ai.plan]}</span>}
        </div>
        {e.source === 'trial' && e.trialEndsAt && (
          <SettingsRow label="Tu prueba termina" value={<span data-testid="trial-end">{longDate(formatLimaDateTime(e.trialEndsAt).slice(0, 10))}</span>} hint="Después sigues en Free, sin cargos, con todos tus datos." />
        )}
        {plus && sub.data && e.source !== 'trial' && (
          <SettingsRow label="Estado" value={sub.data.status === 'past_due' ? 'Pago pendiente' : 'Activo'}
            hint={sub.data.current_period_end ? `Se renueva el ${longDate(sub.data.current_period_end.slice(0, 10))}` : undefined} />
        )}
        {!plus && (e.trialAvailable ? (
          <div className="settings-row">
            <ActionForm action={startTrialAction} label="Cambiar a Plus" className="inline">
              <button type="submit" data-testid="upgrade">Cambiar a Plus · prueba de {config.trial_days} días</button>
            </ActionForm>
            <small className="muted">Sin tarjeta. Al terminar sigues en Free con todos tus datos.</small>
          </div>
        ) : <SettingsRow label="Cambiar a Plus" hint="La suscripción estará disponible pronto." />)}
      </SettingsSection>

      <SettingsSection title="Uso" testId="ai-usage">
        <UsageMeter percent={meter.percent} resetLabel={resetLabel} />
        {ai.reached && <p className="settings-row small">Llegaste al uso incluido. Todo lo demás sigue funcionando{ai.plan === 'free' ? '; puedes seguir el próximo mes o cambiar a Plus' : ''}.</p>}
        {ai.onboarding && <p className="settings-row muted small">Mientras configuras Velsuno usas un saldo aparte ({ai.onboarding.cameraUsed} de {ai.onboarding.cameraLimit} fotos).</p>}
        <SettingsRow label="Lecturas con cámara" value={<span data-testid="camera-usage">{ai.camera.used} de {ai.camera.limit}</span>} />
        <SettingsRow label="Movimientos automáticos este mes" value={<span data-testid="auto-usage">{auto.count ?? 0}{limit !== null ? ` de ${limit}` : ''}</span>} />
      </SettingsSection>

      <SettingsSection title="Incluye">
        <SettingsRow label="Historial de movimientos" value={e.limits.historyMonths === null ? 'Completo' : e.limits.historyMonths === 1 ? 'Mes actual' : `Últimos ${e.limits.historyMonths} meses`} />
        <SettingsRow label="Bancos con automatización" value={String(e.limits.institutions ?? 'Sin límite')} />
        <SettingsRow label="Cobros que se repiten" value={e.features.recurringDetection ? 'Incluido' : 'En Plus'} />
      </SettingsSection>

      {demo.data && (
        <SettingsSection title="Modo demo" description="Solo para probar la experiencia. No cambia tu suscripción ni tus datos." testId="demo-controls">
          <ActionForm action={setDemoPlanAction} label="Simular plan" className="stack-sm">
            <fieldset className="segmented settings-choice">
              <legend className="settings-row-label">Simular límites de</legend>
              <div className="segments">
                {([['', 'Real'], ['free', 'Free'], ['trial', 'Prueba'], ['plus', 'Plus']] as const).map(([v, l]) => (
                  <label key={v} className="segment"><input type="radio" name="plan" value={v} defaultChecked={(simulated ?? '') === v} /><span>{l}</span></label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="secondary">Aplicar</button>
          </ActionForm>
          <ActionForm action={resetDemoOnboardingAction} label="Reiniciar bienvenida demo" className="settings-row">
            <button type="submit" className="secondary">Reiniciar bienvenida demo</button>
          </ActionForm>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
