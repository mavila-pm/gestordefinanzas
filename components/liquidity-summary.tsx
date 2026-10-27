import Link from 'next/link';
import { formatMoney, type Currency } from '../src/domain/money';
import { plural } from '../src/domain/plural';
import { shortDate } from '../src/domain/dates';
import type { Liquidity } from '../src/engine/liquidity';

const m = (v: number | null, c: Currency) => (v === null ? 'Sin dato' : formatMoney({ amountMinor: v, currency: c }));

/**
 * "Tu liquidez" (ADR-0020): money today per currency — bancos + efectivo — from Cuentas y tarjetas, or the last total
 * the person stated while no account has a balance. PEN and USD side by side, never summed. Credit availability is
 * shown apart and never added. Unknown says "Sin dato" with the way to complete it.
 */
export function LiquiditySummary({ liquidity, creditAvailable, compact = false }: {
  liquidity: Record<Currency, Liquidity>;
  creditAvailable?: Partial<Record<Currency, number>>;
  compact?: boolean;
}) {
  const shown = (['PEN', 'USD'] as Currency[]).filter((c) => liquidity[c].source !== null || c === 'PEN');
  return (
    <div className="liq-grid" data-testid="liquidity">
      {shown.map((c) => {
        const l = liquidity[c];
        return (
          <section key={c} className="card stack-sm" aria-label={`Liquidez en ${c === 'USD' ? 'dólares' : 'soles'}`}>
            <span className="muted small">Liquidez total{c === 'USD' ? ' en dólares' : ''}</span>
            <strong className="liq-figure">{m(l.totalMinor, c)}</strong>
            {l.source === null ? (
              <p className="muted small">Agrega tus cuentas y efectivo para verla. <Link href="/app/tarjetas">Agregar cuentas</Link></p>
            ) : (
              <>
                {!compact && (
                  <div>
                    <div className="balance-row"><span>Bancos</span><span className="amount">{m(l.bankMinor, c)}</span></div>
                    <div className="balance-row"><span>Efectivo</span><span className="amount">{m(l.cashMinor, c)}</span></div>
                    {creditAvailable?.[c] !== undefined && (
                      <div className="balance-row muted"><span>Crédito disponible <small>(no es liquidez)</small></span><span className="amount">{m(creditAvailable[c] ?? null, c)}</span></div>
                    )}
                  </div>
                )}
                <small className="muted">
                  {l.source === 'declared'
                    ? `Es lo que nos dijiste${l.asOf ? ` el ${shortDate(l.asOf.slice(0, 10))}` : ''}. Agrega tus cuentas para que se actualice sola.`
                    : 'Se actualiza con cada ingreso y gasto confirmado.'}
                  {l.pendingCount ? ` ${plural(l.pendingCount, 'movimiento por revisar aún no cuenta', 'movimientos por revisar aún no cuentan')}.` : ''}
                </small>
                {l.missing.length > 0 && (
                  <ul className="plain stack-sm small">
                    {l.missing.slice(0, 3).map((x, i) => (
                      <li key={i} className="notice warning"><span>
                        {x.code === 'account_balance' ? <>Falta el saldo de {x.alias}. <Link href={`/app/tarjetas#a-${x.accountId}`}>Completar</Link></>
                          : x.code === 'cash_destination' ? <>Retiraste {m(x.amountMinor, c)}: ¿lo llevas en efectivo? <Link href="/app/tarjetas#efectivo">Agregar efectivo</Link></>
                          : x.code === 'unassigned' ? <>{plural(x.count, 'movimiento no dice', 'movimientos no dicen')} de qué cuenta salió o a cuál entró ({m(x.amountMinor, c)}): aún no mueven tu saldo. <Link href="/app/movimientos">Revisar</Link></>
                          : x.code === 'truncated' ? <>Tienes muchos movimientos desde tu último saldo. Actualiza tus saldos para que la cifra sea exacta.</>
                          : <>¿A qué cuenta fue tu transferencia de {m(x.amountMinor, c)}? <Link href={`/app/movimientos/${x.txId}`}>Indicar</Link></>}
                      </span></li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
