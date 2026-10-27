import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { CardVisual } from '../../../components/card-visual';
import { CardFormFields } from '../../../components/card-form';
import { StatementSheet } from '../../../components/card-position';
import { TxRow } from '../../../components/tx-row';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { activeOnly, loadCatalog } from '../../../lib/queries';
import { loadPlanningData } from '../../../lib/planning';
import { loadCardViews } from '../../../lib/cards';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { shortDate } from '../../../src/domain/dates';
import { plural } from '../../../src/domain/plural';
import { instrumentMonth } from '../../../src/engine/dashboard';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth } from '../../../src/web/auth-input';
import { limaDayLabel, monthLabel } from '../../../src/web/labels';
import { isUuid } from '../../../src/web/transaction-input';
import { createAccountAction, createCardAction, deactivateAction, updateCardCycleAction } from '../actions';

export const metadata = { title: 'Cuentas y tarjetas' };
const BANKS = <><option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="">Otro</option></>;
const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;
/** Enough for any person's two months; if it is ever reached, the month figures say "parcial" instead of being silently low. */
const LIMIT = 1500;
const m = (v: number | null, c: Currency) => (v === null ? null : formatMoney({ amountMinor: v, currency: c }));

function Deactivate({ id, kind, name }: { id: string; kind: 'card' | 'account'; name: string }) {
  return (
    <Sheet label="Desactivar" triggerClassName="quiet" title={`Desactivar ${name}`} subtitle="Ya no reconoceremos con ella movimientos nuevos. Tu historial no cambia.">
      <div className="sheet-body">
        <ActionForm action={deactivateAction} className="inline" label={`Desactivar ${name}`} closeOnSuccess>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="kind" value={kind} />
          <button type="submit" className="danger wide">Desactivar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

/** One fact; unknown is written as "Sin dato" (never 0) with the way to complete it nearby. */
const Fact = ({ label, value, note }: { label: string; value: string | null; note?: string }) => (
  <div><dt>{label}</dt><dd className={value === null ? 'unknown' : ''}>{value ?? 'Sin dato'}{note && <small className="muted"> {note}</small>}</dd></div>
);

/**
 * Cuentas y tarjetas. Cards: a gallery of Velsuno card illustrations; the chosen one shows its cycle (facturado,
 * mínimo, línea, utilizado — only what was registered) and its movements. Accounts: list + detail with the month's
 * movements, own transfers apart. A card payment is never spending again; movements are not a balance.
 */
export default async function CardsAndAccounts({ searchParams }: { searchParams: Promise<{ tarjeta?: string; cuenta?: string }> }) {
  const { tarjeta, cuenta } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [catalog, cardViews] = await Promise.all([loadCatalog(supabase), loadCardViews(supabase, loadPlanningData(supabase))]);
  const views = new Map(cardViews.map((v) => [v.id, v]));
  const cards = activeOnly(catalog.cards);
  const accounts = activeOnly(catalog.accounts);
  const card = cards.find((c) => c.id === tarjeta) ?? cards[0] ?? null;
  const account = accounts.find((a) => a.id === cuenta) ?? accounts[0] ?? null;
  const month = limaMonth();
  const since = new Date(Date.now() - 62 * 86_400_000).toISOString();
  const [cardTx, accTx] = await Promise.all([
    card && isUuid(card.id) ? supabase.from('transactions').select(TRANSACTION_SELECT).eq('card_id', card.id).gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(LIMIT) : null,
    account && isUuid(account.id) ? supabase.from('transactions').select(TRANSACTION_SELECT).eq('account_id', account.id).gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(LIMIT) : null,
  ]);
  const cardMoves = ((cardTx?.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction);
  const accMoves = ((accTx?.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction);
  const view = card ? views.get(card.id) ?? null : null;
  const p = view?.position ?? null;
  const cur = (card?.currency ?? 'PEN') as Currency;
  const cardMonth = card ? instrumentMonth(cardMoves, month, cur) : null;
  const cardPartial = cardMoves.length >= LIMIT;
  const accPartial = accMoves.length >= LIMIT;
  const accMonth = account ? instrumentMonth(accMoves, month, account.currency as Currency) : null;
  const usePct = p && p.limitMinor && p.usedMinor !== null ? Math.round((p.usedMinor / p.limitMinor) * 100) : null;

  return (
    <main className="stack cards-page">
      <header className="row">
        <div className="page-head">
          <h1>Cuentas y tarjetas</h1>
          <p>Con ellas reconocemos tus compras y tus transferencias entre cuentas propias.</p>
        </div>
        <div className="actions">
          <Sheet label={<><Icon name="add" size={18} />Agregar tarjeta</>} triggerClassName="button" title="Nueva tarjeta" subtitle="Nunca pongas el número completo, CVV, PIN ni claves." testId="card-sheet">
            <div className="sheet-body"><ActionForm action={createCardAction} label="Registrar tarjeta" closeOnSuccess><CardFormFields /></ActionForm></div>
          </Sheet>
        </div>
      </header>

      {/* ── Tarjetas ── */}
      <section className="stack" aria-labelledby="h-cards" id="tarjetas">
        <h2 id="h-cards">Tarjetas</h2>
        {cards.length === 0 ? <p className="muted">Aún no hay tarjetas. Si registras tu tarjeta de crédito, sus compras se confirman solas.</p> : (
          <>
            <ul className="plain cv-gallery" data-testid="card-list" aria-label="Tus tarjetas">
              {cards.map((c) => (
                <li key={c.id}>
                  <Link href={`/app/tarjetas?tarjeta=${c.id}${account ? `&cuenta=${account.id}` : ''}#tarjetas`} className="cv-link" aria-current={card?.id === c.id ? 'true' : undefined} scroll={false}>
                    <CardVisual alias={c.alias} institution={c.institution} kind={c.kind} currency={c.currency as Currency} last4={c.last4} size="sm" selected={card?.id === c.id} />
                  </Link>
                </li>
              ))}
            </ul>

            {card && (
              <div className="cv-detail" data-testid="card-detail">
                <section className="card stack" aria-label={`Detalle de ${card.alias}`}>
                  <div className="row"><h3>{card.alias} <span className="muted small">···· {card.last4}</span></h3>
                    <span className="state-chip active">{card.kind === 'credit' ? 'Crédito' : 'Débito'} · {cur === 'USD' ? 'US$' : 'S/'}</span></div>
                  {card.kind === 'credit' ? (
                    <>
                      <dl className="sub-facts">
                        <Fact label="Por pagar este ciclo" value={p?.billed ? m(p.billed.amountMinor, cur) : null} note={p?.billed && p.billed.status === 'estimated' ? '· estimado' : undefined} />
                        <Fact label="Pago mínimo" value={p?.billed ? m(p.billed.minimumMinor, cur) : null} />
                        <Fact label="Fecha límite de pago" value={p?.billed ? shortDate(p.billed.dueDate) : card.paymentDay ? `Día ${card.paymentDay}` : null} />
                        <Fact label="Próximo corte" value={p?.nextCut ? shortDate(p.nextCut) : card.statementDay ? `Día ${card.statementDay}` : null} />
                        <Fact label="Línea total" value={m(p?.limitMinor ?? card.creditLimitMinor ?? null, cur)} />
                        <Fact label="Utilizado" value={m(p?.usedMinor ?? null, cur)} note={p?.usedMinor != null && view?.statement?.usedAsOf ? `al ${shortDate(view.statement.usedAsOf.slice(0, 10))}` : undefined} />
                        <Fact label="Disponible del banco" value={m(p?.bankAvailableMinor ?? null, cur)} note={usePct !== null ? `· usas el ${usePct}%` : undefined} />
                        {p?.purchaseTodayPaidOn && <Fact label="Lo que compres hoy" value={`se paga el ${shortDate(p.purchaseTodayPaidOn)}`} />}
                        {p?.postCutMinor ? <Fact label="Después del corte" value={m(p.postCutMinor, cur)} note="va al próximo estado" /> : null}
                      </dl>
                      {usePct !== null && <span className="progress" aria-hidden="true"><span className={`fill${usePct >= 30 ? ' warning' : ''}`} style={{ width: `${Math.min(100, Math.max(2, usePct))}%` }} /></span>}
                      {p?.statementOutdated && <p className="notice warning small"><span>Tu estado de cuenta es de un corte anterior. Agrega el nuevo.</span></p>}
                      {p?.minimumOnly && <p className="muted small">Si pagas solo el mínimo pasan {m(p.minimumOnly.carriedMinor, cur)} al próximo ciclo{p.minimumOnly.interestMinor ? ` (~${m(p.minimumOnly.interestMinor, cur)} de interés)` : ' con interés'}.</p>}
                      <small className="muted">La línea del banco no es dinero disponible. Pagar la tarjeta no vuelve a contar como gasto.</small>
                    </>
                  ) : <p className="muted small">Débito: sus compras salen de tu cuenta y cuentan como gasto una sola vez.</p>}
                  <div className="sub-actions">
                    {view && <StatementSheet v={view} />}
                    {card.kind === 'credit' && (
                      <Sheet label="Ciclo y línea" triggerClassName="quiet" triggerLabel={`Ciclo de ${card.alias}`} title={`Ciclo · ${card.alias}`} subtitle="Vels lo usa para decirte cuándo pagas lo que compras.">
                        <div className="sheet-body">
                          <ActionForm action={updateCardCycleAction} label={`Ciclo de ${card.alias}`} closeOnSuccess>
                            <input type="hidden" name="id" value={card.id} />
                            <div className="field-row">
                              <label className="stack-sm"><span>Día de corte</span><input name="statementDay" inputMode="numeric" maxLength={2} defaultValue={card.statementDay ?? ''} placeholder="23" /></label>
                              <label className="stack-sm"><span>Día de pago</span><input name="paymentDay" inputMode="numeric" maxLength={2} defaultValue={card.paymentDay ?? ''} placeholder="19" /></label>
                            </div>
                            <label className="stack-sm"><span>Línea del banco</span><span className="money-input"><span className="cur" aria-hidden="true">{cur === 'USD' ? 'US$' : 'S/'}</span>
                              <input name="limit" inputMode="decimal" defaultValue={card.creditLimitMinor ? (card.creditLimitMinor / 100).toFixed(2) : ''} placeholder="10000" /></span></label>
                            <small className="muted">La línea del banco no es tu presupuesto. Vels calcula cuánto puedes usar.</small>
                            <button type="submit" className="wide">Guardar</button>
                          </ActionForm>
                        </div>
                      </Sheet>
                    )}
                    <Deactivate id={card.id} kind="card" name={card.alias} />
                  </div>
                </section>

                <section className="card stack-sm" aria-labelledby="h-card-moves">
                  <div className="row"><h3 id="h-card-moves">Movimientos</h3>
                    {cardMonth && <small className="muted">{monthLabel(month)}{cardPartial ? ' (parcial)' : ''}: {m(cardMonth.outMinor, cur)} en compras{cardMonth.internalCount ? ` · ${plural(cardMonth.internalCount, 'pago de tarjeta', 'pagos de tarjeta')} (no es gasto)` : ''}</small>}</div>
                  {cardMoves.length === 0 ? <p className="muted small">Sin movimientos con esta tarjeta en los últimos dos meses.</p> : (
                    <ul className="tx-list" data-testid="card-moves">{cardMoves.slice(0, 8).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}</ul>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Cuentas ── */}
      <section className="stack" aria-labelledby="h-acc" id="cuentas">
        <div className="row"><h2 id="h-acc">Cuentas</h2>
          <Sheet label={<><Icon name="add" size={18} />Agregar cuenta</>} triggerClassName="quiet" title="Nueva cuenta" subtitle="Solo el nombre y los últimos 4 dígitos." testId="account-sheet">
            <div className="sheet-body">
              <ActionForm action={createAccountAction} label="Registrar cuenta" closeOnSuccess>
                <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Ahorros BBVA" /></label>
                <div className="field-row">
                  <label className="stack-sm"><span>Últimos 4 dígitos</span><input name="last4" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" /></label>
                  <label className="stack-sm"><span>Banco</span><select name="institution" defaultValue="BCP">{BANKS}</select></label>
                </div>
                <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
                <button type="submit" className="wide">Agregar cuenta</button>
              </ActionForm>
            </div>
          </Sheet>
        </div>
        {accounts.length === 0 ? <p className="muted">Aún no hay cuentas. Agrégalas para que pasar dinero entre ellas no cuente como gasto.</p> : (
          <div className="acc-layout">
            <ul className="plain sub-list" data-testid="account-list" aria-label="Tus cuentas">
              {accounts.map((a) => (
                <li key={a.id}>
                  <Link href={`/app/tarjetas?cuenta=${a.id}${card ? `&tarjeta=${card.id}` : ''}#cuentas`} scroll={false} className={`sub-row${account?.id === a.id ? ' selected' : ''}`} aria-current={account?.id === a.id ? 'true' : undefined}>
                    <span className="acc-dot" data-currency={a.currency} aria-hidden="true">{a.currency === 'USD' ? 'US$' : 'S/'}</span>
                    <span className="setting-text"><strong>{a.alias}{a.last4 ? ` ···· ${a.last4}` : ''}</strong>
                      <small className="muted">{[a.institution ?? 'Otro banco', a.currency === 'USD' ? 'Dólares' : 'Soles'].join(' · ')}{a.last4 ? '' : ' · sin dígitos: no detecta transferencias'}</small></span>
                  </Link>
                </li>
              ))}
            </ul>
            {account && accMonth && (
              <section className="card stack-sm" aria-labelledby="h-acc-detail" data-testid="account-detail">
                <div className="row"><h3 id="h-acc-detail">{account.alias}</h3><Deactivate id={account.id} kind="account" name={account.alias} /></div>
                <dl className="sub-facts">
                  <Fact label="Entradas del mes" value={m(accMonth.inMinor, account.currency as Currency)} />
                  <Fact label="Salidas del mes" value={m(accMonth.outMinor, account.currency as Currency)} />
                  <Fact label="Transferencias propias" value={String(accMonth.internalCount)} note="no son ingreso ni gasto" />
                  {accMonth.cashCount > 0 && <Fact label="Retiros de efectivo" value={String(accMonth.cashCount)} />}
                </dl>
                <small className="muted">Son los movimientos de {monthLabel(month).toLowerCase()}{accPartial ? ' (parcial)' : ''}, no el saldo de la cuenta.{accMonth.pendingCount ? ` ${plural(accMonth.pendingCount, 'movimiento por revisar aún no cuenta', 'movimientos por revisar aún no cuentan')}.` : ''}</small>
                {accMoves.length === 0 ? <p className="muted small">Sin movimientos en esta cuenta en los últimos dos meses.</p> : (
                  <ul className="tx-list" data-testid="account-moves">{accMoves.slice(0, 8).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}</ul>
                )}
              </section>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
