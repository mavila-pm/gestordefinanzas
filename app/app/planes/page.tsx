import Link from 'next/link';
import { Icon } from '../../../components/ui/icon';
import { loadBillingState, loadPrices } from '../../../lib/billing';
import { loadEntitlements } from '../../../lib/queries';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { annualSavingPercent, PLAN_CODES, PLAN_INFO, PLUS_FEATURES } from '../../../src/domain/billing';
import { formatMoney } from '../../../src/domain/money';

export const metadata = { title: 'Planes' };

/** Selección de plan: Mensual, Anual y Vitalicio with server prices; Free stays as the no-cost option. */
export default async function Plans() {
  const supabase = await createSupabaseServerClient();
  const [{ prices, monthly2027 }, state, { entitlements: e, config }] = await Promise.all([loadPrices(supabase), loadBillingState(supabase), loadEntitlements(supabase)]);
  const usd = (m: number) => formatMoney({ amountMinor: m, currency: 'USD' });
  const saving = annualSavingPercent(prices.monthly, prices.annual);
  const paid = state.billingPlan !== null && ['active', 'trialing', 'past_due'].includes(state.status ?? '');
  const trial = !state.trialUsed && !paid;

  return (
    <main className="stack plans-page" data-testid="plans">
      <div className="page-head">
        <h1>Elige tu plan</h1>
        <p>{paid ? `Tienes Plus ${PLAN_INFO[state.billingPlan!].name}.` : e.plan === 'plus' ? 'Estás usando Plus en prueba. Elige cómo seguir.' : 'Tus datos y funciones esenciales siguen gratis. Plus te da más.'}</p>
      </div>

      <ul className="plan-grid" role="list">
        {PLAN_CODES.map((code) => {
          const info = PLAN_INFO[code];
          const current = paid && state.billingPlan === code;
          return (
            <li key={code} className={`card plan-card${code === 'annual' ? ' featured' : ''}`} data-testid={`plan-${code}`}>
              <div className="plan-card-head">
                <h2>{info.name}</h2>
                {code === 'annual' && saving !== null && <span className="tag plus">Ahorras {saving}%</span>}
                {info.badge && <span className="tag plus">{info.badge}</span>}
              </div>
              <p className="plan-price"><strong data-testid={`price-${code}`}>{usd(prices[code])}</strong> <span className="muted">{info.period}</span></p>
              {code === 'monthly' && monthly2027 !== prices.monthly && <p className="muted small">Precio de lanzamiento. Desde enero de 2027: {usd(monthly2027)} al mes.</p>}
              {info.recurring && trial && <p className="small"><Icon name="check" size={16} /> {config.trial_days} días gratis para probar</p>}
              {!info.recurring && <p className="small">Un solo pago. Sin renovaciones.</p>}
              {current
                ? <p className="tag">Tu plan actual</p>
                : paid
                  ? null
                  : <Link href={`/app/planes/pago?plan=${code}`} className={`button${code === 'annual' ? '' : ' secondary'}`} data-testid={`choose-${code}`}>Elegir {info.name}</Link>}
            </li>
          );
        })}
      </ul>

      <section className="card stack-sm" aria-labelledby="plus-includes">
        <h2 id="plus-includes">Todos los planes Plus incluyen</h2>
        <ul className="check-list">{PLUS_FEATURES.map((f) => <li key={f}><Icon name="check" size={16} /> {f}</li>)}</ul>
      </section>

      <p className="muted small">Precios en dólares (US$). Pago seguro con Culqi: Velsuno no guarda los datos de tu tarjeta. Puedes cancelar cuando quieras; si cancelas, conservas Plus hasta el final del periodo pagado y nunca pierdes tus datos. <Link href="/terminos">Términos</Link>.</p>
      <Link href="/app/ajustes/plan" className="button secondary">Seguir con mi plan actual</Link>
    </main>
  );
}
