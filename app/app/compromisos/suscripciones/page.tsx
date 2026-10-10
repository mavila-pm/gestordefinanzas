import Link from 'next/link';
import { ActionForm } from '../../../../components/action-form';
import { Icon } from '../../../../components/ui/icon';
import { Sheet } from '../../../../components/ui/sheet';
import { SubLogo } from '../../../../components/sub-logo';
import { SubscriptionFields, type SubscriptionInitial } from '../../../../components/subscription-fields';
import { Lifecycle } from '../../../../components/recurrence';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { loadSubscriptions } from '../../../../lib/subscriptions';
import { loadPlanningData } from '../../../../lib/planning';
import { addDays, limaToday, shortDate } from '../../../../src/domain/dates';
import { formatMoney, type Currency } from '../../../../src/domain/money';
import { plural } from '../../../../src/domain/plural';
import { providerBySlug } from '../../../../src/domain/subscriptions';
import { monthlyEquivalentMinor, nextCharge, paymentHistory, subscriptionState, subscriptionTotals, type SubscriptionRow } from '../../../../src/engine/subscriptions';
import { isUuid } from '../../../../src/web/transaction-input';
import { markObligationPaidAction } from '../../plan/actions';
import { convertToSubscriptionAction, saveSubscriptionAction } from './actions';

export const metadata = { title: 'Mis suscripciones' };
const money = (v: number, c: Currency) => formatMoney({ amountMinor: v, currency: c });
const FREQ = { monthly: 'Mensual', bimonthly: 'Bimestral', quarterly: 'Trimestral', yearly: 'Anual' } as const;
const STATE = { active: 'Activa', paused: 'En pausa', ended: 'Finalizada', pending: 'Por confirmar' } as const;
const periodLabel = (p: string) => new Date(`${p.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Mis suscripciones: what I pay, how much, when it charges again and what I really paid. Subscriptions are obligations
 * (one engine with Próximos pagos and Dinero disponible); the history is only linked real movements.
 * Desktop: list + detail side by side. Phone: the list, then the detail as its own screen (?id=).
 */
export default async function Subscriptions({ searchParams }: { searchParams: Promise<{ id?: string; nuevo?: string }> }) {
  const { id } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [data, plan] = await Promise.all([loadSubscriptions(supabase), loadPlanningData(supabase)]);
  const today = limaToday();
  const { subs, settlements, instruments } = data;
  const settledBy = new Map<string, Set<string>>();
  for (const x of settlements) (settledBy.get(x.obligationId) ?? settledBy.set(x.obligationId, new Set()).get(x.obligationId)!).add(x.period);
  const live = subs.filter((s) => subscriptionState(s, today) !== 'ended');
  const ended = subs.filter((s) => subscriptionState(s, today) === 'ended');
  const sorted = live.map((s) => ({ s, next: nextCharge(s, today, settledBy.get(s.id) ?? new Set()) }))
    .sort((a, b) => (a.next?.date ?? '9999').localeCompare(b.next?.date ?? '9999') || a.s.name.localeCompare(b.s.name));
  const selected = isUuid(id) ? subs.find((s) => s.id === id) ?? null : null;
  const totals = subscriptionTotals(subs, settlements, today);
  const instrumentLabel = (s: SubscriptionRow) => instruments.find((i) => i.id === (s.cardId ?? s.accountId))?.label ?? null;
  const options = instruments.map((i) => ({ value: `${i.kind}:${i.id}`, label: `${i.kind === 'card' ? 'Tarjeta' : 'Cuenta'} · ${i.label}` }));
  const blank: SubscriptionInitial = { provider: null, name: '', amount: '', currency: 'PEN', frequency: 'monthly', nextDate: '', instrument: '' };

  const addSheet = (
    <Sheet label={<><Icon name="add" />Añadir suscripción</>} triggerClassName="button" title="Añadir suscripción" testId="sub-add"
      subtitle="Elige el servicio, su precio y cuándo se cobra.">
      <div className="sheet-body">
        <ActionForm action={saveSubscriptionAction} label="Añadir suscripción" closeOnSuccess>
          <SubscriptionFields initial={blank} instruments={options} today={today} />
        </ActionForm>
      </div>
    </Sheet>
  );

  const detail = selected && (() => {
    const s = selected;
    const state = subscriptionState(s, today);
    const next = nextCharge(s, today, settledBy.get(s.id) ?? new Set());
    const history = paymentHistory(s.id, settlements);
    const eq = monthlyEquivalentMinor(s);
    const providerName = providerBySlug(s.provider)?.name ?? s.name;
    const suggestions = plan.suggestions.filter((m) => m.obligationId === s.id).slice(0, 2);
    const initial: SubscriptionInitial = {
      id: s.id, provider: s.provider, name: s.name, amount: s.amountMinor === null ? '' : (s.amountMinor / 100).toFixed(2), currency: s.currency,
      frequency: s.frequency === 'yearly' || s.frequency === 'quarterly' ? s.frequency : 'monthly', nextDate: next?.date ?? '', instrument: s.cardId ? `card:${s.cardId}` : s.accountId ? `account:${s.accountId}` : '',
    };
    return (
      <section className="card stack sub-detail" aria-labelledby="sub-detail-h" data-testid="sub-detail">
        <Link href="/app/compromisos/suscripciones" className="section-link sub-back"><Icon name="back" size={16} />Mis suscripciones</Link>
        <header className="sub-detail-head">
          <SubLogo provider={s.provider} name={s.name} size={56} />
          <div className="page-head">
            <h2 id="sub-detail-h">{s.name}</h2>
            <span className={`state-chip ${state}`}>{STATE[state]}</span>
          </div>
        </header>
        <dl className="sub-facts">
          <div><dt>Precio</dt><dd className={s.amountMinor === null ? 'unknown' : ''}>{s.amountMinor === null ? 'Por confirmar' : money(s.amountMinor, s.currency)} <small className="muted">{FREQ[s.frequency].toLowerCase()}</small></dd></div>
          <div><dt>Próximo cobro</dt><dd>{next?.date ? <>{shortDate(next.date)}{next.overdue && <small className="muted"> · sin pago registrado aún</small>}</> : state === 'ended' ? '—' : 'Por confirmar'}</dd></div>
          <div><dt>Se paga con</dt><dd>{instrumentLabel(s) ?? <span className="muted">Sin indicar</span>}</dd></div>
          {s.frequency !== 'monthly' && eq !== null && <div><dt>Equivale a</dt><dd>{money(eq, s.currency)} <small className="muted">al mes (estimado)</small></dd></div>}
        </dl>

        {suggestions.map((m) => {
          const t = plan.transactionsById.get(m.transactionId);
          return (
            <div key={m.transactionId} className="source row" data-testid="sub-suggestion">
              <span className="setting-text"><span>{t?.merchant ?? 'Movimiento'} · {t ? money(t.amountMinor, s.currency) : ''} · {t ? shortDate(t.occurredOn) : ''}</span>
                <small className="muted">¿Es el cobro de {periodLabel(m.period)}?</small></span>
              <ActionForm action={markObligationPaidAction} className="inline" label={`Confirmar pago de ${s.name}`}>
                <input type="hidden" name="obligationId" value={s.id} /><input type="hidden" name="transactionId" value={m.transactionId} /><input type="hidden" name="period" value={m.period} />
                <button type="submit" className="quiet">Sí, es ese</button>
              </ActionForm>
            </div>
          );
        })}

        <section className="stack-sm" aria-labelledby="sub-hist-h">
          <h3 id="sub-hist-h">Historial de pagos</h3>
          {history.length === 0 ? <p className="muted small" data-testid="sub-history-empty">Sin pagos registrados todavía. Cuando llegue el cobro, confírmalo aquí o en Próximos pagos.</p> : (
            <div className="table-wrap">
              <table className="data-table interactive" data-testid="sub-history">
                <thead><tr><th scope="col">Periodo</th><th scope="col">Fecha</th><th scope="col">Importe</th><th scope="col">Origen</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.period}>
                      <th scope="row">{periodLabel(h.period)}</th>
                      <td>{h.occurredOn ? shortDate(h.occurredOn) : '—'}</td>
                      <td>{h.status === 'skipped' ? <span className="muted">Omitido</span> : h.amountMinor === null ? <span className="muted">Sin dato</span> : money(h.amountMinor, h.currency ?? s.currency)}</td>
                      <td>{h.status === 'skipped' ? <span className="muted">No se pagó este periodo</span> : h.transactionId ? <Link href={`/app/movimientos/${h.transactionId}`}>{h.merchant ?? 'Ver movimiento'}</Link> : <span className="muted">Sin movimiento</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {state !== 'ended' && (
          <div className="sub-actions">
            <Sheet label="Editar" triggerClassName="secondary" title={`Editar ${s.name}`} testId="sub-edit" subtitle="El cambio aplica a los próximos cobros. Lo ya pagado no cambia.">
              <div className="sheet-body"><ActionForm action={saveSubscriptionAction} label={`Editar ${s.name}`} closeOnSuccess>
                <SubscriptionFields initial={initial} instruments={options} today={today} />
              </ActionForm></div>
            </Sheet>
            <Sheet label="Pausar o dejar de seguir" triggerClassName="quiet" title={s.name} testId="sub-lifecycle"
              subtitle={`Solo cambia tu plan en Velsuno. Esto no cancela tu suscripción en ${providerName}.`}>
              <div className="sheet-body">
                <Lifecycle kind="obligation" id={s.id} name={s.name} pausedUntil={s.pausedUntil ?? null} endedOn={s.endedOn ?? null} today={today} defaultUntil={addDays(today, 30)} />
              </div>
            </Sheet>
          </div>
        )}
        {state === 'ended' && <p className="muted small">Ya no la sigues en Velsuno. Su historial se queda. Esto no cancela nada con {providerName}.</p>}
      </section>
    );
  })();

  return (
    <main className={`stack subs${selected ? ' has-detail' : ''}`}>
      <header className="row">
        <div className="page-head">
          <Link href="/app/compromisos" className="section-link"><Icon name="back" size={16} />Próximos pagos</Link>
          <h1>Mis suscripciones</h1>
          <p>Los servicios que pagas cada mes o cada año.</p>
        </div>
        {addSheet}
      </header>

      {data.candidates.length > 0 && (
        <div className="stack-sm" data-testid="sub-candidates">
          {data.candidates.slice(0, 3).map((c) => (
            <div key={c.id} className="source row">
              <span className="setting-text"><span>«{c.name}» parece una suscripción</span><small className="muted">Pásala aquí con su historial, sin duplicar el pago.</small></span>
              <ActionForm action={convertToSubscriptionAction} className="inline" label={`Pasar ${c.name} a suscripciones`}>
                <input type="hidden" name="id" value={c.id} /><button type="submit" className="quiet">Pasar a suscripciones</button>
              </ActionForm>
            </div>
          ))}
        </div>
      )}

      {totals.map((t) => (
        <section key={t.currency} className="kpis sub-kpis" aria-label={`Suscripciones en ${t.currency === 'PEN' ? 'soles' : 'dólares'}`} data-testid={`sub-totals-${t.currency}`}>
          <div className="kpi"><span>Activas{totals.length > 1 ? ` · ${t.currency}` : ''}</span><strong>{t.active}</strong></div>
          <div className="kpi"><span>Próximos 30 días</span><strong>{money(t.next30Minor, t.currency)}</strong>
            <small className="muted">{plural(t.next30Count, 'cobro', 'cobros')}{t.next30Unknown ? ` · ${t.next30Unknown} por confirmar` : ''}</small></div>
          <div className="kpi"><span>Costo mensual</span><strong>{money(t.monthlyMinor, t.currency)}</strong>
            <small className="muted">Estimado{t.monthlyUnknown ? ` · sin ${plural(t.monthlyUnknown, 'precio', 'precios')}` : ''}</small></div>
          <div className="kpi"><span>Pagado este mes</span><strong>{money(t.paidMonthMinor, t.currency)}</strong>
            <small className="muted">{t.paidMonthCount ? `${plural(t.paidMonthCount, 'pago confirmado', 'pagos confirmados')}` : 'Sin pagos confirmados'}</small></div>
        </section>
      ))}

      {subs.length === 0 ? (
        <section className="card stack-sm sub-empty" data-testid="sub-empty">
          <h2>Aún no tienes suscripciones</h2>
          <p className="muted">Agrega Netflix, Spotify o el servicio que pagues: verás cuánto te cuestan y cuándo se cobran.</p>
          <div>{addSheet}</div>
        </section>
      ) : (
        <div className="subs-layout">
          <section aria-label="Tus suscripciones" className="sub-list-wrap">
            <ul className="plain sub-list" data-testid="sub-list">
              {sorted.map(({ s, next }) => {
                const state = subscriptionState(s, today);
                return (
                  <li key={s.id}>
                    <Link href={`/app/compromisos/suscripciones?id=${s.id}`} className={`sub-row${selected?.id === s.id ? ' selected' : ''}`} aria-current={selected?.id === s.id ? 'true' : undefined} data-testid="sub-row">
                      <SubLogo provider={s.provider} name={s.name} />
                      <span className="setting-text"><strong>{s.name}</strong>
                        <small className="muted">{[next?.date ? `${next.overdue ? 'Venció' : 'Cobra'} el ${shortDate(next.date)}` : 'Fecha por confirmar', instrumentLabel(s)].filter(Boolean).join(' · ')}</small></span>
                      <span className="sub-row-end">
                        <strong className={`amount${s.amountMinor === null ? ' unknown' : ''}`}>{s.amountMinor === null ? 'Por confirmar' : money(s.amountMinor, s.currency)}</strong>
                        <small className="muted">{state === 'active' ? FREQ[s.frequency] : STATE[state]}</small>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {ended.length > 0 && (
              <details className="sub-ended">
                <summary>{plural(ended.length, 'finalizada', 'finalizadas')}</summary>
                <ul className="plain sub-list">
                  {ended.map((s) => (
                    <li key={s.id}><Link href={`/app/compromisos/suscripciones?id=${s.id}`} className="sub-row muted-row">
                      <SubLogo provider={s.provider} name={s.name} /><span className="setting-text"><strong>{s.name}</strong><small className="muted">Ya no la sigues · su historial se queda</small></span>
                    </Link></li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          {detail ?? (
            <section className="card sub-detail sub-placeholder" aria-hidden="true">
              <p className="muted">Elige una suscripción para ver su historial de pagos.</p>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
