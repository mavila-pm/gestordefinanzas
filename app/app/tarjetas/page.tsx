import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { CardVisual } from '../../../components/card-visual';
import { CardAccountsFields, CardFormFields } from '../../../components/card-form';
import { StatementSheet } from '../../../components/card-position';
import { LiquiditySummary } from '../../../components/liquidity-summary';
import { TxRow } from '../../../components/tx-row';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadPlanningData } from '../../../lib/planning';
import { loadCardViews } from '../../../lib/cards';
import { loadMoneySources, type SourceAccount, type SourceCard } from '../../../lib/money-sources';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { shortDate } from '../../../src/domain/dates';
import { plural } from '../../../src/domain/plural';
import { limaDatePlus } from '../../../src/domain/billing';
import { instrumentMonth } from '../../../src/engine/dashboard';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth } from '../../../src/web/auth-input';
import { limaDayLabel, monthLabel } from '../../../src/web/labels';
import { isUuid } from '../../../src/web/transaction-input';
import { BANK_LABEL } from '../../../src/web/money-source-input';
import { createAccountAction, deactivateAction, updateCardCycleAction } from '../actions';
import { addCardAccountsAction, adjustAccountBalanceAction, adjustCardUsedAction, saveCardAction, setCashAction } from './actions';

export const metadata = { title: 'Cuentas y tarjetas' };
const BANKS = <><option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="">Otro</option></>;
const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;
/** Enough for any person's two months; if it is ever reached, the month figures say "parcial" instead of being silently low. */
const LIMIT = 1500;
const m = (v: number | null, c: Currency) => (v === null ? null : formatMoney({ amountMinor: v, currency: c }));
const sym = (c: Currency) => (c === 'USD' ? 'US$' : 'S/');
const expiryText = (c: SourceCard) => (c.expiryMonth && c.expiryYear ? `${String(c.expiryMonth).padStart(2, '0')}/${String(c.expiryYear).slice(2)}` : null);
const bankText = (x: { institution: string | null; bankName: string | null }) => (x.institution ? BANK_LABEL[x.institution] ?? x.institution : x.bankName ?? 'Otro banco');

/** Months from today's month to the card's expiry month (0 = expires this month; negative = expired). */
function monthsToExpiry(c: SourceCard, today: string): number | null {
  if (!c.expiryMonth || !c.expiryYear) return null;
  const y = Number(today.slice(0, 4));
  const mo = Number(today.slice(5, 7));
  return (c.expiryYear - y) * 12 + (c.expiryMonth - mo);
}

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

/** "Actualizar saldo": what the bank app shows today becomes a new checkpoint (the past is never rewritten). */
function BalanceSheet({ a }: { a: SourceAccount }) {
  const cash = a.kind === 'cash';
  return (
    <Sheet label={a.balanceMinor === null ? 'Agregar saldo' : 'Actualizar'} triggerClassName="quiet" triggerLabel={`Saldo de ${a.alias}`}
      title={cash ? `Efectivo${a.currency === 'USD' ? ' en dólares' : ''}` : `Saldo · ${a.alias}`}
      subtitle={cash ? 'Cuánto tienes en efectivo ahora.' : 'El saldo que ves hoy en la app de tu banco.'}>
      <div className="sheet-body">
        <ActionForm action={cash ? setCashAction : adjustAccountBalanceAction} label={`Saldo de ${a.alias}`} closeOnSuccess>
          {cash ? <input type="hidden" name="currency" value={a.currency} /> : <input type="hidden" name="accountId" value={a.id} />}
          <label className="stack-sm"><span>{cash ? 'Efectivo hoy' : 'Saldo hoy'}</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(a.currency)}</span>
            <input name="amount" required inputMode="decimal" placeholder="1500" defaultValue={a.balanceMinor !== null && a.balanceMinor >= 0 ? (a.balanceMinor / 100).toFixed(2) : ''} /></span></label>
          <small className="muted">Desde ahora, cada movimiento confirmado lo actualiza solo.</small>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

function AccountLine({ a }: { a: SourceAccount }) {
  return (
    <div className="balance-row" id={`a-${a.id}`}>
      <span className="setting-text"><strong>{a.alias}</strong>
        <small className="muted">{a.currency === 'USD' ? 'Dólares' : 'Soles'}{a.balanceAsOf ? ` · desde el ${shortDate(a.balanceAsOf.slice(0, 10))}` : ''}</small></span>
      <span className="row"><span className={`amount${a.balanceMinor === null ? ' muted' : ''}`}>{m(a.balanceMinor, a.currency) ?? 'Sin saldo'}</span><BalanceSheet a={a} /></span>
    </div>
  );
}

/** One fact; unknown is written as "Sin dato" (never 0) with the way to complete it nearby. */
const Fact = ({ label, value, note }: { label: string; value: string | null; note?: string }) => (
  <div><dt>{label}</dt><dd className={value === null ? 'unknown' : ''}>{value ?? 'Sin dato'}{note && <small className="muted"> {note}</small>}</dd></div>
);

/**
 * Cuentas y tarjetas (CR-001, ADR-0020): where liquidity comes from. Liquidez (bancos + efectivo per currency, credit
 * apart) · Efectivo · Tarjetas: debit cards hold their accounts (balance today, "Agregar cuenta a tarjeta"); credit
 * cards show line, used today (derived from the last "used" + purchases − payments) and their cycle · other accounts.
 * A card payment is never spending again; credit availability is never liquidity.
 */
export default async function CardsAndAccounts({ searchParams }: { searchParams: Promise<{ tarjeta?: string; cuenta?: string }> }) {
  const { tarjeta, cuenta } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [sources, cardViews] = await Promise.all([loadMoneySources(supabase), loadCardViews(supabase, loadPlanningData(supabase))]);
  const today = limaDatePlus(new Date(), 0);
  const views = new Map(cardViews.map((v) => [v.id, v]));
  const cards = sources.cards.filter((c) => c.active);
  const accounts = sources.accounts.filter((a) => a.active);
  const cash = accounts.filter((a) => a.kind === 'cash');
  const loose = accounts.filter((a) => a.kind === 'bank' && !a.cardId);
  const card = cards.find((c) => c.id === tarjeta) ?? cards[0] ?? null;
  const account = loose.find((a) => a.id === cuenta) ?? loose[0] ?? null;
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
  const accMonth = account ? instrumentMonth(accMoves, month, account.currency) : null;
  // Used today: the derived one (checkpoint + purchases − payments) wins; else the statement's; else unknown.
  const used = card?.usedMinor ?? p?.usedMinor ?? null;
  const limit = card?.creditLimitMinor ?? null;
  const available = card?.availableMinor ?? p?.bankAvailableMinor ?? null;
  const usePct = limit && used !== null ? Math.round((used / limit) * 100) : null;
  const cardAccounts = card ? accounts.filter((a) => a.cardId === card.id) : [];
  const creditAvailable: Partial<Record<Currency, number>> = {};
  for (const c of cards) if (c.kind === 'credit' && c.availableMinor !== null) creditAvailable[c.currency] = (creditAvailable[c.currency] ?? 0) + c.availableMinor;
  const expiresIn = card ? monthsToExpiry(card, today) : null;

  return (
    <main className="stack cards-page">
      <header className="row">
        <div className="page-head">
          <h1>Cuentas y tarjetas</h1>
          <p>De aquí sale tu liquidez: lo que tienes en bancos y en efectivo.</p>
        </div>
        <div className="actions">
          <Sheet label={<><Icon name="add" size={18} />Agregar tarjeta</>} triggerClassName="button" title="Nueva tarjeta" subtitle="Nunca pongas el número completo, CVV, PIN ni claves." testId="card-sheet">
            <div className="sheet-body"><ActionForm action={saveCardAction} label="Registrar tarjeta" closeOnSuccess><CardFormFields /></ActionForm></div>
          </Sheet>
        </div>
      </header>

      <section className="stack" aria-labelledby="h-liq">
        <h2 id="h-liq">Tu liquidez</h2>
        <LiquiditySummary liquidity={sources.liquidity} creditAvailable={creditAvailable} />
      </section>

      {/* ── Efectivo ── */}
      <section className="stack-sm" aria-labelledby="h-cash" id="efectivo">
        <div className="row"><h2 id="h-cash">Efectivo</h2>
          {!cash.some((a) => a.currency === 'PEN') && (
            <Sheet label={<><Icon name="add" size={18} />Agregar efectivo</>} triggerClassName="quiet" title="Efectivo" subtitle="Cuánto tienes en efectivo ahora. Es opcional." testId="cash-sheet">
              <div className="sheet-body">
                <ActionForm action={setCashAction} label="Agregar efectivo" closeOnSuccess>
                  <div className="field-row">
                    <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
                    <label className="stack-sm"><span>Monto</span><input name="amount" required inputMode="decimal" placeholder="150" /></label>
                  </div>
                  <button type="submit" className="wide">Guardar</button>
                </ActionForm>
              </div>
            </Sheet>
          )}
        </div>
        {cash.length === 0
          ? <p className="muted">Si llevas efectivo, agrégalo: tus gastos en efectivo lo irán bajando.</p>
          : <div className="card">{cash.map((a) => <AccountLine key={a.id} a={a} />)}</div>}
      </section>

      {/* ── Tarjetas ── */}
      <section className="stack" aria-labelledby="h-cards" id="tarjetas">
        <h2 id="h-cards">Tarjetas</h2>
        {cards.length === 0 ? <p className="muted">Empieza por tu tarjeta de débito y sus cuentas: así ves tu liquidez y tus gastos la actualizan solos.</p> : (
          <>
            <ul className="plain cv-gallery" data-testid="card-list" aria-label="Tus tarjetas">
              {cards.map((c) => (
                <li key={c.id}>
                  <Link href={`/app/tarjetas?tarjeta=${c.id}${account ? `&cuenta=${account.id}` : ''}#tarjetas`} className="cv-link" aria-current={card?.id === c.id ? 'true' : undefined} scroll={false}>
                    <CardVisual alias={c.alias} institution={c.institution} bankName={c.bankName} kind={c.kind} currency={c.currency} last4={c.last4} color={c.color} expiry={expiryText(c)} size="sm" selected={card?.id === c.id} />
                  </Link>
                </li>
              ))}
            </ul>

            {card && (
              <div className="cv-detail" data-testid="card-detail">
                <section className="card stack" aria-label={`Detalle de ${card.alias}`}>
                  <div className="row"><h3>{card.alias} <span className="muted small">{bankText(card)} ···· {card.last4}</span></h3>
                    <span className="state-chip active">{card.kind === 'credit' ? `Crédito · ${sym(cur)}` : 'Débito'}</span></div>
                  {expiresIn !== null && expiresIn <= 2 && (
                    <p className="notice warning small"><span>{expiresIn < 0 ? 'Esta tarjeta ya venció.' : expiresIn === 0 ? 'Esta tarjeta vence este mes.' : `Esta tarjeta vence en ${plural(expiresIn, 'mes', 'meses')}.`} Revisa tus pagos automáticos con ella.</span></p>
                  )}
                  {card.kind === 'credit' ? (
                    <>
                      <dl className="sub-facts">
                        <Fact label="Línea total" value={m(limit, cur)} />
                        <Fact label="Línea usada" value={m(used, cur)} note={card.usedAsOf ? 'se actualiza con tus compras y pagos' : view?.statement?.usedAsOf ? `al ${shortDate(view.statement.usedAsOf.slice(0, 10))}` : undefined} />
                        <Fact label="Disponible del banco" value={m(available, cur)} note={usePct !== null ? `· usas el ${usePct}%` : undefined} />
                        <Fact label="Por pagar este ciclo" value={p?.billed ? m(p.billed.amountMinor, cur) : null} note={p?.billed && p.billed.status === 'estimated' ? '· estimado' : undefined} />
                        <Fact label="Pago mínimo" value={p?.billed ? m(p.billed.minimumMinor, cur) : null} />
                        <Fact label="Fecha límite de pago" value={p?.billed ? shortDate(p.billed.dueDate) : card.paymentDay ? `Día ${card.paymentDay}` : null} />
                        <Fact label="Próximo corte" value={p?.nextCut ? shortDate(p.nextCut) : card.statementDay ? `Día ${card.statementDay}` : null} />
                        {expiryText(card) && <Fact label="Vence" value={expiryText(card)} />}
                        {p?.purchaseTodayPaidOn && <Fact label="Lo que compres hoy" value={`se paga el ${shortDate(p.purchaseTodayPaidOn)}`} />}
                      </dl>
                      {usePct !== null && <span className="progress" aria-hidden="true"><span className={`fill${usePct >= 30 ? ' warning' : ''}`} style={{ width: `${Math.min(100, Math.max(2, usePct))}%` }} /></span>}
                      {p?.statementOutdated && <p className="notice warning small"><span>Tu estado de cuenta es de un corte anterior. Agrega el nuevo.</span></p>}
                      {p?.minimumOnly && <p className="muted small">Si pagas solo el mínimo pasan {m(p.minimumOnly.carriedMinor, cur)} al próximo ciclo{p.minimumOnly.interestMinor ? ` (~${m(p.minimumOnly.interestMinor, cur)} de interés)` : ' con interés'}.</p>}
                      <small className="muted">La línea no es liquidez. Pagar la tarjeta baja tu cuenta y la línea usada, y no vuelve a contar como gasto.</small>
                    </>
                  ) : (
                    <div className="stack-sm">
                      <h4>Cuentas de esta tarjeta</h4>
                      {cardAccounts.length === 0
                        ? <p className="muted small">Agrega sus cuentas (por ejemplo, Ahorros Soles) para que sus compras bajen el saldo correcto.</p>
                        : <div>{cardAccounts.map((a) => <AccountLine key={a.id} a={a} />)}</div>}
                      <small className="muted">Una compra con esta tarjeta sale de la cuenta en su moneda. Si hay dos en la misma moneda, te preguntamos de cuál.</small>
                    </div>
                  )}
                  <div className="sub-actions">
                    {card.kind === 'debit' && (
                      <Sheet label={<><Icon name="add" size={18} />Agregar cuenta a tarjeta</>} triggerClassName="quiet" title={`Cuentas · ${card.alias}`} subtitle="Nombre, moneda y saldo de hoy." testId="card-accounts-sheet">
                        <div className="sheet-body"><ActionForm action={addCardAccountsAction} label={`Cuentas de ${card.alias}`} closeOnSuccess><CardAccountsFields cardId={card.id} /></ActionForm></div>
                      </Sheet>
                    )}
                    {card.kind === 'credit' && (
                      <Sheet label="Actualizar línea usada" triggerClassName="quiet" title={`Línea usada · ${card.alias}`} subtitle="Lo que ves hoy en la app de tu banco.">
                        <div className="sheet-body">
                          <ActionForm action={adjustCardUsedAction} label={`Línea usada de ${card.alias}`} closeOnSuccess>
                            <input type="hidden" name="cardId" value={card.id} />
                            <label className="stack-sm"><span>Línea usada hoy</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(cur)}</span>
                              <input name="amount" required inputMode="decimal" placeholder="1200" /></span></label>
                            <button type="submit" className="wide">Guardar</button>
                          </ActionForm>
                        </div>
                      </Sheet>
                    )}
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
                            <label className="stack-sm"><span>Línea de la tarjeta</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(cur)}</span>
                              <input name="limit" inputMode="decimal" defaultValue={card.creditLimitMinor ? (card.creditLimitMinor / 100).toFixed(2) : ''} placeholder="10000" /></span></label>
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
                    {cardMonth && <small className="muted">{monthLabel(month)}{cardMoves.length >= LIMIT ? ' (parcial)' : ''}: {m(cardMonth.outMinor, cur)} en compras{cardMonth.internalCount ? ` · ${plural(cardMonth.internalCount, 'pago de tarjeta', 'pagos de tarjeta')} (no es gasto)` : ''}</small>}</div>
                  {cardMoves.length === 0 ? <p className="muted small">Sin movimientos con esta tarjeta en los últimos dos meses.</p> : (
                    <ul className="tx-list" data-testid="card-moves">{cardMoves.slice(0, 8).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}</ul>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Otras cuentas (sin tarjeta) ── */}
      <section className="stack" aria-labelledby="h-acc" id="cuentas">
        <div className="row"><h2 id="h-acc">Otras cuentas</h2>
          <Sheet label={<><Icon name="add" size={18} />Agregar cuenta</>} triggerClassName="quiet" title="Nueva cuenta" subtitle="Una cuenta sin tarjeta de débito. Solo el nombre y los últimos 4 dígitos." testId="account-sheet">
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
        {loose.length === 0 ? <p className="muted small">Las cuentas de tus tarjetas de débito aparecen dentro de cada tarjeta.</p> : (
          <div className="acc-layout">
            <ul className="plain sub-list" data-testid="account-list" aria-label="Tus cuentas">
              {loose.map((a) => (
                <li key={a.id}>
                  <Link href={`/app/tarjetas?cuenta=${a.id}${card ? `&tarjeta=${card.id}` : ''}#cuentas`} scroll={false} className={`sub-row${account?.id === a.id ? ' selected' : ''}`} aria-current={account?.id === a.id ? 'true' : undefined}>
                    <span className="acc-dot" data-currency={a.currency} aria-hidden="true">{sym(a.currency)}</span>
                    <span className="setting-text"><strong>{a.alias}{a.last4 ? ` ···· ${a.last4}` : ''}</strong>
                      <small className="muted">{[bankText(a), m(a.balanceMinor, a.currency) ?? 'sin saldo'].join(' · ')}</small></span>
                  </Link>
                </li>
              ))}
            </ul>
            {account && accMonth && (
              <section className="card stack-sm" aria-labelledby="h-acc-detail" data-testid="account-detail">
                <div className="row"><h3 id="h-acc-detail">{account.alias}</h3><Deactivate id={account.id} kind="account" name={account.alias} /></div>
                <AccountLine a={account} />
                <dl className="sub-facts">
                  <Fact label="Entradas del mes" value={m(accMonth.inMinor, account.currency)} />
                  <Fact label="Salidas del mes" value={m(accMonth.outMinor, account.currency)} />
                  <Fact label="Transferencias propias" value={String(accMonth.internalCount)} note="no son ingreso ni gasto" />
                  {accMonth.cashCount > 0 && <Fact label="Retiros de efectivo" value={String(accMonth.cashCount)} />}
                </dl>
                <small className="muted">Movimientos de {monthLabel(month).toLowerCase()}{accMoves.length >= LIMIT ? ' (parcial)' : ''}.{accMonth.pendingCount ? ` ${plural(accMonth.pendingCount, 'movimiento por revisar aún no cuenta', 'movimientos por revisar aún no cuentan')}.` : ''}</small>
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
