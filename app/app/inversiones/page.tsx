import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadInvestments, type InvestmentView } from '../../../lib/investments';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { shortDate } from '../../../src/domain/dates';
import { limaDatePlus } from '../../../src/domain/billing';
import { INVESTMENT_KINDS, KIND_LABEL, totals } from '../../../src/engine/investments';
import { addInvestmentEntryAction, archiveInvestmentAction, createInvestmentAction } from './actions';

export const metadata = { title: 'Inversiones' };
const m = (v: number, c: Currency) => formatMoney({ amountMinor: v, currency: c });
const sym = (c: Currency) => (c === 'USD' ? 'US$' : 'S/');
const ENTRY: Record<string, string> = { contribution: 'Aporte', withdrawal: 'Retiro', valuation: 'Valor' };
const pct = (bp: number) => `${bp > 0 ? '+' : ''}${(bp / 100).toFixed(1)}%`;

function EntrySheet({ i, kind }: { i: InvestmentView; kind: 'contribution' | 'withdrawal' | 'valuation' }) {
  const label = kind === 'valuation' ? 'Actualizar valor' : kind === 'contribution' ? 'Aportar' : 'Retirar';
  return (
    <Sheet label={label} triggerClassName={kind === 'valuation' ? 'quiet' : 'link small'} triggerLabel={`${label} · ${i.name}`} title={`${label} · ${i.name}`}
      subtitle={kind === 'valuation' ? 'Lo que vale hoy según tu plataforma o banco.' : kind === 'contribution' ? 'Dinero que pusiste en esta inversión.' : 'Dinero que sacaste de esta inversión.'}>
      <div className="sheet-body">
        <ActionForm action={addInvestmentEntryAction} label={`${label} ${i.name}`} closeOnSuccess resetOnSuccess>
          <input type="hidden" name="investmentId" value={i.id} /><input type="hidden" name="kind" value={kind} />
          <div className="field-row">
            <label className="stack-sm"><span>{kind === 'valuation' ? 'Vale hoy' : 'Monto'}</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(i.currency)}</span>
              <input name="amount" required inputMode="decimal" placeholder="1000" /></span></label>
            <label className="stack-sm"><span>Fecha</span><input name="date" type="date" defaultValue={limaDatePlus(new Date(), 0)} max={limaDatePlus(new Date(), 0)} /></label>
          </div>
          {kind !== 'valuation' && <small className="muted">Si el dinero salió o entró de una de tus cuentas, regístralo también como transferencia entre tus cuentas.</small>}
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

/**
 * Inversiones (UX audit §2.3, CR-002): manual tracking of any kind of investment — what was contributed, what it is
 * worth today (the person's own reading, "estimado") and the difference. Never quotes, ranks or advises (MOTHER §89).
 * Investments are not liquidity: they are shown apart, per currency.
 */
export default async function Investments() {
  const supabase = await createSupabaseServerClient();
  const items = await loadInvestments(supabase);
  const currencies = (['PEN', 'USD'] as Currency[]).filter((c) => c === 'PEN' || items.some((i) => i.currency === c));
  const positions = items.map((i) => i.position);

  return (
    <main className="stack">
      <header className="row">
        <div className="page-head"><h1>Inversiones</h1><p>Sigue lo que aportaste y cuánto vale hoy. No es parte de tu liquidez.</p></div>
        <div className="actions">
          <Link href="/app/preguntar?tema=inversion" className="button quiet"><Icon name="chat" size={18} />Contárselo a Vels</Link>
          <Sheet label={<><Icon name="add" size={18} />Agregar inversión</>} triggerClassName="button" title="Nueva inversión" subtitle="Solo para seguirla. Velsuno no compra ni recomienda inversiones." testId="investment-sheet">
            <div className="sheet-body">
              <ActionForm action={createInvestmentAction} label="Registrar inversión" closeOnSuccess resetOnSuccess>
                <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={60} placeholder="Fondo conservador" /></label>
                <div className="field-row">
                  <label className="stack-sm"><span>Tipo</span><select name="kind" defaultValue="fondo_mutuo">{INVESTMENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
                  <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
                </div>
                <label className="stack-sm"><span>Dónde la tienes <small className="muted">(opcional)</small></span><input name="institution" maxLength={40} placeholder="Credicorp Capital" /></label>
                <div className="field-row">
                  <label className="stack-sm"><span>Aportado hasta hoy</span><input name="contributed" inputMode="decimal" placeholder="2000" /></label>
                  <label className="stack-sm"><span>Vale hoy <small className="muted">(opcional)</small></span><input name="value" inputMode="decimal" placeholder="2150" /></label>
                </div>
                <label className="stack-sm"><span>Tasa o rendimiento anual % <small className="muted">(opcional, informativo)</small></span><input name="rate" inputMode="decimal" placeholder="6.5" /></label>
                <small className="muted">Si no sabes cuánto vale hoy, déjalo vacío: no lo inventamos.</small>
                <button type="submit" className="wide">Agregar inversión</button>
              </ActionForm>
            </div>
          </Sheet>
        </div>
      </header>

      <section className="liq-grid" aria-label="Total invertido">
        {currencies.map((c) => {
          const t = totals(positions, c);
          return (
            <section key={c} className="card stack-sm" data-testid={`investments-total-${c}`}>
              <span className="muted small">Aportado{c === 'USD' ? ' en dólares' : ''}</span>
              <strong className="liq-figure">{t.contributedMinor === null ? 'Sin dato' : m(t.contributedMinor, c)}</strong>
              {t.missingContributed > 0 && <small className="muted">Falta lo aportado en {t.missingContributed === 1 ? '1 inversión' : `${t.missingContributed} inversiones`}.</small>}
              <div className="balance-row"><span>Vale hoy <small className="muted">(estimado)</small></span>
                <span className="amount">{t.valueMinor === null ? (t.missingValue ? `Falta el valor de ${t.missingValue}` : 'Sin dato') : m(t.valueMinor, c)}</span></div>
              {t.valueMinor !== null && t.contributedMinor !== null && <div className="balance-row"><span>Diferencia</span><span className="amount">{t.valueMinor - t.contributedMinor >= 0 ? '+' : '−'}{m(Math.abs(t.valueMinor - t.contributedMinor), c)}</span></div>}
            </section>
          );
        })}
      </section>

      {items.length === 0 ? <p className="muted">Si tienes un plazo fijo, un fondo, acciones o un negocio, agrégalo para seguir cuánto vale.</p> : (
        <ul className="plain stack-sm" aria-label="Tus inversiones">
          {items.map((i) => {
            const p = i.position;
            return (
              <li key={i.id} className="card stack-sm" data-testid="investment">
                <div className="row"><span className="setting-text"><strong>{i.name}</strong>
                  <small className="muted">{KIND_LABEL[i.kind]}{i.institution ? ` · ${i.institution}` : ''}{i.annualRateBp !== null ? ` · ${(i.annualRateBp / 100).toFixed(2)}% anual (informado)` : ''}</small></span>
                  <span className="state-chip active">{sym(i.currency)}</span></div>
                <dl className="sub-facts">
                  <div><dt>Aportado</dt><dd className={p.contributedMinor === null ? 'unknown' : ''}>{p.contributedMinor === null ? 'Sin dato' : m(p.contributedMinor, i.currency)}</dd></div>
                  <div><dt>Vale hoy</dt><dd className={p.valueMinor === null ? 'unknown' : ''}>{p.valueMinor === null ? 'Sin dato' : m(p.valueMinor, i.currency)}{p.valueOn && <small className="muted"> al {shortDate(p.valueOn)}</small>}</dd></div>
                  <div><dt>Diferencia</dt><dd className={p.gainMinor === null ? 'unknown' : ''}>{p.gainMinor === null ? 'Sin dato' : `${p.gainMinor >= 0 ? '+' : '−'}${m(Math.abs(p.gainMinor), i.currency)}`}{p.gainBp !== null && <small className="muted"> {pct(p.gainBp)}</small>}</dd></div>
                </dl>
                {i.entries.length > 0 && (
                  <details><summary className="small">Historial</summary>
                    {i.entries.map((e, k) => <div key={k} className="balance-row small"><span>{ENTRY[e.kind]} · {shortDate(e.onDate)}</span><span className="amount">{m(e.amountMinor, i.currency)}</span></div>)}
                  </details>
                )}
                <div className="sub-actions">
                  <EntrySheet i={i} kind="valuation" />
                  <EntrySheet i={i} kind="contribution" />
                  {p.contributedMinor !== null && p.contributedMinor > 0 && <EntrySheet i={i} kind="withdrawal" />}
                  <ActionForm action={archiveInvestmentAction} className="inline" label={`Archivar ${i.name}`}>
                    <input type="hidden" name="investmentId" value={i.id} />
                    <button type="submit" className="link small muted-link">Archivar</button>
                  </ActionForm>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <small className="muted">Velsuno solo registra lo que tú le dices: no consulta precios, no compara ni recomienda inversiones.</small>
    </main>
  );
}
