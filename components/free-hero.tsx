import Link from 'next/link';
import { formatMoney, type Currency } from '../src/domain/money';
import { planBreakdown, type Plan } from '../src/engine/planning';
import { daysBetween } from '../src/domain/dates';
import { shortDate } from '../src/domain/dates';

/**
 * Resumen opens with what the person can use until the next income (ADR-0005), explained by one bar:
 * pagos + reservado + disponible = saldo. Estimated stays "Estimado"; a missing datum is one tap away; no balance → no number.
 */
const money = (v: number, c: Currency) => formatMoney({ amountMinor: Math.abs(v), currency: c });
/** Short name of the first missing datum ("monto de Internet"), from the engine's own message. */
function missingLabel(m: Plan['missing'][number]): string {
  // Engine texts: "Falta el monto de X.", "Falta la fecha de X.", "Confirma si X vence el 9 o el 10."
  const win = m.text.match(/^Confirma si (.+?) vence /);
  if (win) return `la fecha de ${win[1]}`;
  if (m.code === 'amount' || m.code === 'date') return m.text.replace(/^Falta (el|la) /, 'el ').replace(/^el fecha/, 'la fecha').replace(/\.$/, '');
  return { balance: 'tu saldo de hoy', balance_stale: 'actualizar tu saldo', next_income: 'tu próximo ingreso', essentials: 'cuánto gastas en lo básico', income_window: 'el día de tu ingreso' }[m.code];
}

export function FreeHero({ p }: { p: Plan }) {
  const c = p.currency;
  const b = planBreakdown(p);
  const fix = p.missing.find((m) => m.code !== 'income_window') ?? null;
  if (!b || !p.base) {
    return (
      <section className="hero" aria-label="Dinero disponible" data-testid="free-summary" data-status="incomplete">
        <span className="label">Dinero disponible</span>
        <p>Para calcularlo necesito cuánto tienes hoy y cuándo es tu próximo ingreso.</p>
        <Link href="/app/plan" className="button" style={{ justifySelf: 'start' }}>Calcular</Link>
      </section>
    );
  }
  const shown = Math.max(0, b.freeMinor);
  const days = p.nextIncome ? daysBetween(p.from, p.nextIncome.date) : null;
  return (
    <section className="hero" aria-label="Dinero disponible" data-testid="free-summary" data-status={p.status}>
      <div className="hero-top">
        <span className="label">Dinero disponible</span>
        {p.status !== 'confirmed' && <span className="state">Estimado</span>}
      </div>
      <p className="figure" data-testid="free-summary-amount">{b.freeMinor < 0 ? 'Faltan ' : ''}{money(b.freeMinor, c)}</p>
      {p.nextIncome && (
        <small className="until">Hasta tu próximo ingreso, el <strong>{shortDate(p.nextIncome.date)}</strong>
          {days !== null && days > 0 ? ` (${days} día${days === 1 ? '' : 's'})` : ''}.</small>
      )}
      <div className="free-bar" role="img" data-testid="free-bar"
        aria-label={`De tu saldo de ${money(p.base.amountMinor, c)}: ${money(b.committedMinor, c)} en pagos, ${money(b.setAsideMinor, c)} reservado y ${money(shown, c)} disponible`}>
        <span className="seg committed" style={{ flexGrow: b.committedMinor }} />
        <span className="seg set-aside" style={{ flexGrow: b.setAsideMinor }} />
        <span className="seg free" style={{ flexGrow: shown }} />
      </div>
      <dl className="free-legend">
        <div><dt><i className="committed" />Pagos</dt><dd data-testid="free-committed">{money(b.committedMinor, c)}</dd></div>
        <div><dt><i className="set-aside" />Reservado</dt><dd data-testid="free-set-aside">{money(b.setAsideMinor, c)}</dd></div>
        <div><dt><i className="free" />Disponible</dt><dd>{money(shown, c)}</dd></div>
      </dl>
      <div className="hero-foot">
        <span>{fix ? (p.missing.length === 1 ? `Falta 1 dato: ${missingLabel(fix).replace(/^(el|la) /, '')}` : `Faltan ${p.missing.length} datos, empieza por ${missingLabel(fix)}`) : `Saldo ${money(p.base.amountMinor, c)}`}</span>
        <Link href="/app/plan">{fix ? 'Completar' : 'Ver cálculo'}</Link>
      </div>
    </section>
  );
}

/** "Lo que viene": the plan's own dated lines up to the next income (same numbers as the bar), then that income. */
export function ComingUp({ p }: { p: Plan }) {
  const c = p.currency;
  const lines = p.lines.filter((l) => l.kind === 'payment' || l.kind === 'debt' || l.kind === 'overdue')
    .sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9')).slice(0, 5);
  if (!lines.length && !p.nextIncome) return null;
  const day = (d: string | null) => d ? <><b>{Number(d.slice(8, 10))}</b>{shortDate(d).split(' ')[1]}</> : <b>?</b>;
  return (
    <section aria-labelledby="h-coming" className="stack-sm">
      <div className="row"><h2 id="h-coming">Próximos pagos</h2><Link href="/app/compromisos" className="section-link">Ver todo</Link></div>
      <ul className="plain coming card" data-testid="coming-up">
        {lines.map((l, i) => (
          <li key={i}>
            <span className="day" aria-hidden={!l.date}>{day(l.date)}</span>
            <span className="setting-text"><span>{l.label}</span>
              {(l.kind === 'overdue' || l.dateMax || l.note) && <small className={l.kind === 'overdue' ? 'error' : 'muted'}>{l.kind === 'overdue' ? 'Venció, no vemos el pago' : l.note ?? (l.dateMax ? `Vence ${Number(l.date!.slice(8))}–${Number(l.dateMax.slice(8))}` : '')}</small>}</span>
            <span className={`amount${l.amountMinor === null ? ' unknown' : ''}`}>{l.amountMinor === null ? 'por confirmar' : `−${money(l.amountMinor, c)}`}</span>
          </li>
        ))}
        {p.nextIncome && (
          <>
            <li className="horizon" aria-hidden="true">Tu próximo ingreso</li>
            <li>
              <span className="day">{day(p.nextIncome.date)}</span>
              <span className="setting-text"><span>{p.nextIncome.name}</span><small className="muted">Esperado · aún no llega</small></span>
              <span className={`amount in${p.nextIncome.amountMinor === null ? ' unknown' : ''}`}>{p.nextIncome.amountMinor === null ? 'por confirmar' : `+${money(p.nextIncome.amountMinor, c)}`}</span>
            </li>
          </>
        )}
      </ul>
    </section>
  );
}
