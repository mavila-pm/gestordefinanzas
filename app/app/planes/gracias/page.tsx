import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Icon } from '../../../../components/ui/icon';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { isPlanCode, PLAN_INFO } from '../../../../src/domain/billing';
import { longDate } from '../../../../src/domain/dates';
import { formatMoney } from '../../../../src/domain/money';
import { isUuid } from '../../../../src/web/transaction-input';

export const metadata = { title: 'Gracias por tu compra' };

/**
 * Gracias: reads the order from the database (RLS: only the person's own). Success is shown only for an order
 * the server settled — never because the browser reached this URL (spec: success URLs are not proof of payment).
 */
export default async function Thanks({ searchParams }: { searchParams: Promise<{ pedido?: string }> }) {
  const { pedido } = await searchParams;
  if (!pedido || !isUuid(pedido)) redirect('/app/planes');
  const supabase = await createSupabaseServerClient();
  const { data: o } = await supabase.from('billing_orders').select('plan_code,amount_minor,trial_days,status,provider,provider_ref,settled_at,created_at').eq('id', pedido).maybeSingle();
  if (!o || !isPlanCode(o.plan_code)) redirect('/app/planes');
  const info = PLAN_INFO[o.plan_code];
  const price = formatMoney({ amountMinor: Number(o.amount_minor), currency: 'USD' });
  const settled = o.status === 'paid' || o.status === 'trialing' || o.status === 'simulated';
  const simulated = o.status === 'simulated';
  // A provider charge that went through but could not be activated (failed WITH a provider reference) or was given
  // back: say so — never "no se hizo ningún cargo" when money moved.
  // (A refused trial subscription is cancelled at Culqi before its first charge: nothing was charged.)
  const charged = o.status === 'refunded' || (o.status === 'failed' && !!o.provider_ref && o.trial_days === 0);
  // "Confirmando" only when a provider really received the payment attempt; otherwise nothing was charged.
  const failed = (o.status === 'failed' && !charged) || (o.status === 'pending' && !o.provider);
  // The first charge date of a card-backed trial is Culqi's (subscriptions.trial_ends_at), not a local estimate.
  const { data: sub } = o.status === 'trialing'
    ? await supabase.from('subscriptions').select('trial_ends_at').maybeSingle()
    : { data: null };
  const trialEndAt = sub?.trial_ends_at ?? (o.trial_days > 0 && o.settled_at ? new Date(Date.parse(o.settled_at) + o.trial_days * 86_400_000).toISOString() : null);
  const trialEnd = trialEndAt ? longDate(new Date(Date.parse(trialEndAt) - 5 * 3_600_000).toISOString().slice(0, 10)) : null;

  if (charged) {
    return (
      <main className="stack narrow" data-testid="thanks-refund">
        <div className="page-head">
          <h1>{o.status === 'refunded' ? 'Te devolvimos el pago' : 'No pudimos activar tu plan'}</h1>
          <p>{o.status === 'refunded'
            ? `Devolvimos ${price} a tu tarjeta. Puede tardar unos días en verse en tu estado de cuenta.`
            : `Tu banco aprobó el cobro de ${price}, pero no pudimos activar Plus. Te devolveremos el pago; escríbenos si tienes dudas.`}</p>
        </div>
        <Link href="/app/ajustes/plan" className="button">Ver mi plan</Link>
      </main>
    );
  }

  if (!settled) {
    return (
      <main className="stack narrow" data-testid="thanks-pending">
        <div className="page-head">
          <h1>{failed ? 'No se completó el pago' : 'Estamos confirmando tu pago'}</h1>
          <p>{failed ? 'No se hizo ningún cargo. Puedes intentarlo de nuevo.' : 'Esto suele tardar unos segundos. Tu plan cambia apenas se confirme.'}</p>
        </div>
        <Link href={failed ? `/app/planes/pago?plan=${o.plan_code}` : `/app/planes/gracias?pedido=${pedido}`} className="button">{failed ? 'Intentar de nuevo' : 'Actualizar'}</Link>
      </main>
    );
  }

  return (
    <main className="stack narrow thanks" data-testid="thanks">
      <div className="thanks-mark" aria-hidden="true"><Icon name="check" size={32} /></div>
      <div className="page-head">
        <h1>¡Gracias por tu compra!</h1>
        <p>{simulated ? `Simulaste Velsuno Plus ${info.name}.` : `Ya tienes Velsuno Plus ${info.name}.`}</p>
      </div>
      {o.status === 'simulated' && <p className="notice" data-testid="simulated">Compra simulada (cuenta demo): no se hizo ningún cargo y tu suscripción real no cambió.</p>}
      <section className="card stack-sm" aria-labelledby="order">
        <h2 id="order">Detalle</h2>
        <dl className="summary-list">
          <div><dt>Plan</dt><dd>Plus {info.name}</dd></div>
          <div><dt>Precio</dt><dd>{price} {info.period}</dd></div>
          {trialEnd && <div><dt>Prueba gratis hasta</dt><dd>{trialEnd}</dd></div>}
          <div><dt>{simulated ? 'Cobrado' : trialEnd ? 'Pagado hoy' : 'Pagado'}</dt><dd data-testid="charged">{simulated || trialEnd ? formatMoney({ amountMinor: 0, currency: 'USD' }) : price}</dd></div>
          {o.settled_at && <div><dt>Fecha</dt><dd>{longDate(new Date(Date.parse(o.settled_at) - 5 * 3_600_000).toISOString().slice(0, 10))}</dd></div>}
        </dl>
        {trialEnd && !simulated && <p className="muted small">El primer cobro de {price} será el {trialEnd}. Puedes cancelar antes desde Ajustes → Plan y uso.</p>}
      </section>
      <div className="actions">
        <Link href="/app" className="button">Ir a mi resumen</Link>
        <Link href="/app/ajustes/plan" className="button secondary">Ver mi plan</Link>
      </div>
    </main>
  );
}
