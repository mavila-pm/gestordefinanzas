import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ActionForm } from '../../../../components/action-form';
import { CulqiCheckoutButton } from '../../../../components/culqi-checkout';
import { billingMode, loadBillingState, loadPrices, purchasable } from '../../../../lib/billing';
import { loadEntitlements } from '../../../../lib/queries';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { isPlanCode, limaDatePlus, PLAN_INFO } from '../../../../src/domain/billing';
import { longDate } from '../../../../src/domain/dates';
import { formatMoney } from '../../../../src/domain/money';
import { consentText } from '../../../../src/web/billing-input';
import { checkoutAction } from '../actions';

export const metadata = { title: 'Pago' };

/**
 * Checkout: what is bought, what is charged today and when the next charge happens — said before paying, with
 * explicit acceptance (spec §77: never a charge without consent). The amount shown comes from the server.
 */
export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  if (!isPlanCode(plan)) redirect('/app/planes');
  const supabase = await createSupabaseServerClient();
  const [{ prices, monthly2027 }, state, mode, { config }] = await Promise.all([loadPrices(supabase), loadBillingState(supabase), billingMode(supabase), loadEntitlements(supabase)]);
  if (state.paid) redirect('/app/planes');
  const info = PLAN_INFO[plan];
  const price = formatMoney({ amountMinor: prices[plan], currency: 'USD' });
  const trialDays = info.recurring && !state.trialUsed ? config.trial_days : 0;
  const trialEnd = trialDays ? longDate(limaDatePlus(new Date(), trialDays)) : null;
  const today = formatMoney({ amountMinor: trialDays ? 0 : prices[plan], currency: 'USD' });
  const consent = consentText(plan, price, info.period, trialEnd);
  // Card payment only when the exact Culqi plan for this price (and trial) is configured: never a wrong price.
  const card = mode.kind === 'culqi' && purchasable(mode, plan, prices[plan], trialDays > 0);

  return (
    <main className="stack narrow" data-testid="checkout">
      <div className="page-head">
        <Link href="/app/planes" className="muted small">← Cambiar de plan</Link>
        <h1>Confirma tu compra</h1>
      </div>

      <section className="card stack-sm" aria-labelledby="summary">
        <h2 id="summary">Velsuno Plus {info.name}</h2>
        <dl className="summary-list">
          <div><dt>Precio</dt><dd>{price} {info.period}</dd></div>
          {trialEnd && <div><dt>Prueba gratis</dt><dd>{trialDays} días, hasta el {trialEnd}</dd></div>}
          <div className="total"><dt>Pagas hoy</dt><dd data-testid="pay-today">{today}</dd></div>
          {info.recurring && <div><dt>Próximo cobro</dt><dd>{trialEnd ? `${price} el ${trialEnd}` : `${price} ${plan === 'monthly' ? 'en un mes' : 'en un año'}`}</dd></div>}
        </dl>
        {plan === 'monthly' && monthly2027 !== prices.monthly && <p className="muted small">Desde enero de 2027 la cuota mensual será {formatMoney({ amountMinor: monthly2027, currency: 'USD' })}. Te avisaremos antes del cambio.</p>}
      </section>

      {mode.kind === 'demo' && <p className="notice" data-testid="demo-notice">Cuenta demo: la compra se simula y no se hace ningún cargo.</p>}
      {(mode.kind === 'disabled' || (mode.kind === 'culqi' && !card)) && (
        <p className="notice warning" data-testid="payments-soon">{mode.kind === 'culqi'
          ? 'Este plan aún no se puede pagar con tarjeta. Hoy no se puede completar la compra y no se hará ningún cargo.'
          : 'Los pagos con tarjeta se habilitarán muy pronto. Hoy no se puede completar la compra y no se hará ningún cargo.'}</p>
      )}

      {mode.kind === 'culqi' && card ? (
        <CulqiCheckoutButton plan={plan} amountMinor={prices[plan]} publicKey={mode.publicKey} testMode={!mode.livemode}
          consent={consent} title="Confirmar compra" buttonLabel={trialDays ? `Empezar ${trialDays} días gratis` : `Pagar ${price}`} />
      ) : (
        <ActionForm action={checkoutAction} label="Confirmar compra" className="stack">
          <input type="hidden" name="plan" value={plan} />
          <input type="hidden" name="amount" value={prices[plan]} />
          <label className="check-row">
            <input type="checkbox" name="terms" required data-testid="terms" />
            <span>{consent} <Link href="/terminos">Ver Términos</Link></span>
          </label>
          <button type="submit" data-testid="pay" disabled={mode.kind !== 'demo'}>{mode.kind === 'demo' ? (trialDays ? `Simular ${trialDays} días gratis` : `Simular pago de ${price}`) : trialDays ? `Empezar ${trialDays} días gratis` : `Pagar ${price}`}</button>
        </ActionForm>
      )}
    </main>
  );
}
