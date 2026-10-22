import { ActionForm } from '../../../../components/action-form';
import { SettingsPage, SettingsRow, SettingsSection, UsageMeter } from '../../../../components/settings';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { loadEntitlements } from '../../../../lib/queries';
import { aiPlanFrom, allowance, velsUsage, type AIPlan } from '../../../../src/ai/entitlements';
import { billingDate, paidPlanView, PLAN_INFO } from '../../../../src/domain/billing';
import { longDate } from '../../../../src/domain/dates';
import { SUBSCRIPTION_COLUMNS } from '../../../../src/domain/entitlements';
import { formatMoney } from '../../../../src/domain/money';
import { limaMonth, limaMonthRange } from '../../../../src/web/auth-input';
import { startTrialAction } from '../../actions';
import { resetDemoOnboardingAction, setDemoPlanAction } from '../demo-actions';
import { cancelRenewalAction } from './actions';

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
    supabase.from('subscriptions').select(`${SUBSCRIPTION_COLUMNS},billing_amount_minor,billing_currency,provider_ref`).maybeSingle(),
    supabase.from('demo_access').select('simulated_plan').maybeSingle(),
    supabase.from('onboarding_states').select('status').maybeSingle(),
  ]);
  const now = new Date();
  const simulated = (demo.data?.simulated_plan ?? null) as AIPlan | null;
  const plan = aiPlanFrom(sub.data, simulated, now, config.billing_grace_days);
  const ai = allowance(plan, !!simulated, Object.fromEntries((cfg.data ?? []).map((r) => [r.key, Number(r.value)])), usage.data ?? [], onb.data?.status === 'active', now);
  const meter = velsUsage(ai, now, sub.data?.trial_ends_at ?? null);
  const plus = e.plan === 'plus';
  const limit = e.limits.autoMovementsPerMonth;
  const resetLabel = meter.resetAt ? (meter.renews === 'trial_end' ? `Tu prueba termina el ${longDate(meter.resetAt)}.` : `Se reinicia el ${longDate(meter.resetAt)}. Tu uso se renueva automáticamente cada mes.`) : null;
  // A paid plan (Culqi): its phase, the provider's dates and the next charge. null for Free, card-less trial, by hand.
  const paid = plus ? paidPlanView(sub.data) : null;
  const usd = (m: number) => formatMoney({ amountMinor: m, currency: sub.data?.billing_currency === 'PEN' ? 'PEN' : 'USD' });
  const graceEnd = paid?.phase === 'past_due' && paid.until ? new Date(Date.parse(paid.until) + config.billing_grace_days * 86_400_000).toISOString() : null;

  return (
    <SettingsPage title="Plan y uso" testId="settings-plan">
      <SettingsSection title="Plan actual" testId="plan">
        <div className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-label" data-testid="plan-name" style={{ fontSize: 20 }}>{plus ? 'Plus' : 'Free'}{paid ? ` ${PLAN_INFO[paid.plan].name}` : ''}{e.source === 'trial' ? ' · prueba' : ''}</span>
            <small className="muted">{plus ? 'Todo Velsuno, con más uso de Vels e historial completo.' : 'Las herramientas esenciales para organizar tu dinero.'}</small>
          </span>
          {simulated && <span className="tag">Simulación {PLAN_NAME[ai.plan]}</span>}
        </div>
        {e.source === 'trial' && e.trialEndsAt && !paid && (
          <SettingsRow label="Tu prueba termina" value={<span data-testid="trial-end">{billingDate(e.trialEndsAt)}</span>} hint="Después sigues en Free, sin cargos, con todos tus datos." />
        )}
        {paid?.phase === 'trial' && paid.until && (
          <SettingsRow label="Tu prueba termina" value={<span data-testid="trial-end">{billingDate(paid.until)}</span>}
            hint={paid.nextCharge ? `El primer cobro de ${usd(paid.nextCharge.amountMinor)} será el ${billingDate(paid.nextCharge.at)}. Si cancelas antes, no se cobra nada.` : undefined} />
        )}
        {paid?.phase === 'active' && (
          <SettingsRow label="Estado" value={<span data-testid="plan-status">Activo</span>}
            hint={paid.nextCharge ? `Se renueva el ${billingDate(paid.nextCharge.at)} por ${usd(paid.nextCharge.amountMinor)}.` : undefined} />
        )}
        {paid?.phase === 'past_due' && (
          <SettingsRow label="Estado" value={<span data-testid="plan-status">Pago pendiente</span>}
            hint={graceEnd ? `No pudimos cobrar la renovación. Conservas Plus hasta el ${billingDate(graceEnd)}; después pasas a Free con todos tus datos.` : 'No pudimos cobrar la renovación.'} />
        )}
        {paid?.phase === 'ending' && (
          <SettingsRow label="Renovación" value={<span data-testid="plan-status">Cancelada</span>}
            hint={paid.until ? `Conservas Plus hasta el ${billingDate(paid.until)}. No se hará ningún otro cobro.` : 'No se hará ningún otro cobro.'} />
        )}
        {paid?.phase === 'lifetime' && <SettingsRow label="Estado" value={<span data-testid="plan-status">Vitalicio</span>} hint="Un solo pago. Sin renovaciones ni cobros." />}
        {plus && !paid && sub.data && e.source !== 'trial' && (
          <SettingsRow label="Estado" value={sub.data.status === 'past_due' ? 'Pago pendiente' : 'Activo'}
            hint={sub.data.current_period_end ? `Hasta el ${billingDate(sub.data.current_period_end)}` : undefined} />
        )}
        {paid?.canCancel && paid.until && (
          <details className="settings-row stack-sm" data-testid="cancel-renewal">
            <summary className="button secondary">Cancelar renovación</summary>
            <ActionForm action={cancelRenewalAction} label="Cancelar renovación" className="stack-sm">
              <input type="hidden" name="confirm" value="yes" />
              <p className="small">Conservas Plus hasta el {billingDate(paid.until)}. No se hará ningún otro cobro. Después pasas a Free con todos tus datos.</p>
              <button type="submit" className="secondary" data-testid="confirm-cancel">Sí, cancelar renovación</button>
            </ActionForm>
          </details>
        )}
        {!plus && (e.trialAvailable ? (
          <div className="settings-row">
            <ActionForm action={startTrialAction} label="Cambiar a Plus" className="inline">
              <button type="submit" data-testid="upgrade">Cambiar a Plus · prueba de {config.trial_days} días</button>
            </ActionForm>
            <small className="muted">Sin tarjeta. Al terminar sigues en Free con todos tus datos.</small>
          </div>
        ) : null)}
        {(!plus || (e.source === 'trial' && !paid)) && (
          <div className="settings-row"><a href="/app/planes" className="button secondary" data-testid="see-plans">Ver planes: Mensual, Anual y Vitalicio</a></div>
        )}
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
