import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadEntitlements } from '../../../lib/queries';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { formatLimaDateTime } from '../../../src/web/transaction-input';
import { startTrialAction } from '../actions';

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
  return (
    <main className="stack narrow-md">
      <h1>Cuenta y plan</h1>
      <section className="card stack-sm" data-testid="plan">
        <h2>Plan {e.plan === 'plus' ? 'Plus' : 'Free'}{e.source === 'trial' ? ' (prueba)' : ''}</h2>
        {e.source === 'trial' && e.trialEndsAt && <p data-testid="trial-end">Tu prueba termina el <strong>{formatLimaDateTime(e.trialEndsAt)}</strong>. Luego vuelves a Free sin cargos; tus datos se conservan.</p>}
        <ul className="list">
          <li><span>Movimientos automáticos este mes</span><span data-testid="auto-usage">{used}{limit !== null ? ` / ${limit}` : ''}</span></li>
          <li><span>Historial visible</span><span>{e.limits.historyMonths === null ? 'Completo' : `${e.limits.historyMonths} meses (lo anterior se conserva)`}</span></li>
          <li><span>Bancos con automatización</span><span>{e.limits.institutions}</span></li>
        </ul>
        <p className="muted small">Durante la beta estos límites se muestran pero aún no se aplican. Seguridad, revisión, deduplicación, correcciones y
          exportación de tus datos nunca dependen del plan.</p>
        {e.trialAvailable && (
          <ActionForm action={startTrialAction} label="Probar Plus">
            <button type="submit">Probar Plus {config.trial_days} días gratis (sin tarjeta)</button>
          </ActionForm>
        )}
        {e.plan === 'free' && !e.trialAvailable && <p className="muted">Suscripción a Plus: disponible próximamente.</p>}
      </section>
      <section className="card stack-sm">
        <h2>Tus datos</h2>
        <p><a href="/app/exportar?month=all">Descargar todos mis movimientos (CSV)</a></p>
      </section>
    </main>
  );
}
