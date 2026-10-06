import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadEntitlements } from '../../../lib/queries';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { formatLimaDateTime } from '../../../src/web/transaction-input';
import { startTrialAction } from '../actions';
import { aiPlanFrom, allowance, type AIPlan } from '../../../src/ai/entitlements';
import { resetDemoOnboardingAction, setDemoPlanAction } from './demo-actions';

const PLAN_NAME: Record<AIPlan, string> = { free: 'Free', trial: 'Prueba Plus', plus: 'Plus' };

export const metadata = { title: 'Tu plan' };

export default async function Account() {
  const supabase = await createSupabaseServerClient();
  const range = limaMonthRange(limaMonth())!;
  const [{ entitlements: e, config }, auto, usage, cfg, sub, demo, onb] = await Promise.all([
    loadEntitlements(supabase),
    supabase.from('transaction_sources').select('id', { count: 'exact', head: true }).in('channel', ['email', 'sms', 'import'])
      .gte('received_at', range.from).lt('received_at', range.to),
    supabase.from('ai_usage').select('bucket,weighted_tokens,camera_reads'),
    supabase.from('plan_config').select('key,value').like('key', 'ai_%'),
    supabase.from('subscriptions').select('plan,status,trial_ends_at,current_period_end').maybeSingle(),
    supabase.from('demo_access').select('simulated_plan').maybeSingle(),
    supabase.from('onboarding_states').select('status').maybeSingle(),
  ]);
  const now = new Date();
  const simulated = (demo.data?.simulated_plan ?? null) as AIPlan | null;
  const ai = allowance(aiPlanFrom(sub.data, simulated, now), !!simulated, Object.fromEntries((cfg.data ?? []).map((r) => [r.key, r.value])),
    usage.data ?? [], onb.data?.status === 'active', now);
  const used = auto.count ?? 0;
  const limit = e.limits.autoMovementsPerMonth;
  const plus = e.plan === 'plus';
  return (
    <main className="stack narrow-md">
      <h1>Tu plan</h1>
      <section className="stack-sm" data-testid="plan">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h2 className="lead">Plan {plus ? 'Plus' : 'Free'}{e.source === 'trial' ? ' (prueba)' : ''}</h2>
          {e.source === 'trial' && <span className="tag trial">Prueba activa</span>}
        </div>
        {e.source === 'trial' && e.trialEndsAt && (
          <p data-testid="trial-end">Tu prueba termina el <strong>{formatLimaDateTime(e.trialEndsAt).slice(0, 10)}</strong>. Después sigues en Free, sin cargos, con todos tus datos.</p>
        )}
        <ul className="list card" style={{ paddingTop: 4, paddingBottom: 4 }}>
          <li><span>Movimientos automáticos este mes</span><span className="amount" data-testid="auto-usage">{used}{limit !== null ? ` / ${limit}` : ''}</span></li>
          <li><span>Historial</span><span>{e.limits.historyMonths === null ? 'Completo' : `Últimos ${e.limits.historyMonths} meses`}</span></li>
          <li><span>Bancos con automatización</span><span className="amount">{e.limits.institutions}</span></li>
        </ul>
        {e.trialAvailable && (
          <ActionForm action={startTrialAction} label="Probar Plus">
            <button type="submit" className="wide">Probar Plus {config.trial_days} días, sin tarjeta</button>
          </ActionForm>
        )}
        {!plus && !e.trialAvailable && <p className="muted">La suscripción a Plus estará disponible pronto.</p>}
      </section>
      <section className="stack-sm" data-testid="ai-usage">
        <h2 className="lead">Uso de Velsuno</h2>
        <div className="card stack-sm">
          <div className="row"><span>Conversación</span>{ai.simulated && <span className="tag">Simulación {PLAN_NAME[ai.plan]}</span>}</div>
          <span className="progress" role="meter" aria-label="Conversación usada este mes" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ai.conversation.ratio * 100)}>
            <span className={`fill${ai.conversation.ratio >= 1 ? ' exceeded' : ai.conversation.ratio >= 0.8 ? ' warning' : ''}`} style={{ width: `${Math.max(ai.conversation.ratio * 100, 2)}%` }} />
          </span>
          <p className="muted small">{ai.reached ? 'Llegaste al uso incluido. Todo lo demás sigue funcionando.' : ai.conversation.ratio >= 0.8 ? 'Te queda poco uso incluido este periodo.' : 'Tienes uso disponible.'}</p>
          <div className="row"><span>Lecturas con cámara</span><span className="amount" data-testid="camera-usage">{ai.camera.used} de {ai.camera.limit}</span></div>
          {ai.onboarding && <p className="muted small">Mientras configuras Velsuno usas un saldo aparte ({ai.onboarding.cameraUsed} de {ai.onboarding.cameraLimit} fotos).</p>}
          {ai.reached && ai.plan === 'free' && <p className="small">Puedes seguir el próximo mes o ampliar tu uso con Plus.</p>}
        </div>
      </section>
      {demo.data && (
        <section className="stack-sm" data-testid="demo-controls">
          <h2 className="lead">Modo demo</h2>
          <p className="muted small">Solo para probar la experiencia. No cambia tu suscripción ni tus datos.</p>
          <ActionForm action={setDemoPlanAction} label="Simular plan" className="stack-sm">
            <fieldset className="segmented">
              <legend className="label">Simular límites de</legend>
              <div className="segments">
                {([['', 'Real'], ['free', 'Free'], ['trial', 'Prueba'], ['plus', 'Plus']] as const).map(([v, l]) => (
                  <label key={v} className="segment"><input type="radio" name="plan" value={v} defaultChecked={(simulated ?? '') === v} /><span>{l}</span></label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="secondary">Aplicar</button>
          </ActionForm>
          <ActionForm action={resetDemoOnboardingAction} label="Reiniciar bienvenida demo">
            <button type="submit" className="secondary wide">Reiniciar bienvenida demo</button>
          </ActionForm>
        </section>
      )}
      <p className="muted small">En la beta los límites se muestran, pero no se aplican. Seguridad, revisión, correcciones y descarga de tus datos no dependen del plan.</p>
    </main>
  );
}
