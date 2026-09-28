import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadEntitlements } from '../../../lib/queries';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { formatLimaDateTime } from '../../../src/web/transaction-input';
import { startTrialAction } from '../actions';

export const metadata = { title: 'Tu plan' };

export default async function Account() {
  const supabase = await createSupabaseServerClient();
  const range = limaMonthRange(limaMonth())!;
  const [{ entitlements: e, config }, auto] = await Promise.all([
    loadEntitlements(supabase),
    supabase.from('transaction_sources').select('id', { count: 'exact', head: true }).in('channel', ['email', 'sms', 'import'])
      .gte('received_at', range.from).lt('received_at', range.to),
  ]);
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
      <p className="muted small">Durante la beta los límites se muestran pero no se aplican. La seguridad, la revisión, las correcciones y la descarga de tus datos no dependen del plan.</p>
    </main>
  );
}
