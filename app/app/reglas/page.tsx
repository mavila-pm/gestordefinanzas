import { ActionForm } from '../../../components/action-form';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadCatalog, loadRules } from '../../../lib/queries';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { MONTHS_SHORT } from '../../../src/domain/dates';
import { changeRuleAction, deleteRuleAction } from '../actions';
import { forgetOnboardingAction } from '../../bienvenida/actions';
import { unlinkSettlementAction } from '../plan/actions';

/** Period keys: 'YYYY-MM' (monthly), 'YYYY-MM-01|02' (1st/2nd half of a semimonthly income), 'YYYY-MM-DD' (weekly/biweekly). */
function periodLabel(p: string, frequency?: string) {
  const month = `${MONTHS_SHORT[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
  if (p.length === 7) return month;
  const day = Number(p.slice(8));
  return frequency === 'semimonthly' ? `${month} · ${day === 1 ? '1.ª' : '2.ª'} quincena` : `${day} ${month}`;
}

export const metadata = { title: 'Lo que Velsuno recuerda' };

export default async function Rules() {
  const supabase = await createSupabaseServerClient();
  const [rules, catalog, links, chat] = await Promise.all([
    loadRules(supabase), loadCatalog(supabase),
    supabase.from('plan_settlements').select('id,period,status,fixed_expense:fixed_expenses(name),income:expected_incomes(name,frequency),tx:transactions(amount_minor,currency)')
      .order('created_at', { ascending: false }).limit(10),
    supabase.from('conversation_messages').select('id', { count: 'exact', head: true }).eq('thread', 'onboarding'),
  ]);
  type Link = { id: string; period: string; status: 'paid' | 'skipped'; fixed_expense: { name: string } | null; income: { name: string; frequency: string } | null; tx: { amount_minor: number; currency: Currency } | null };
  const confirmed = (links.data ?? []) as unknown as Link[];
  const categoryId = new Map(catalog.categories.map((c) => [c.name, c.id]));
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Lo que Velsuno recuerda</h1>
        <p>Si corriges una categoría y marcas “usar la próxima vez”, la recordamos para ese comercio.</p>
      </div>
      {rules.length === 0 ? (
        <p className="muted">Aún no recuerda nada. Aparecerá aquí cuando corrijas la categoría de un comercio.</p>
      ) : (
        <ul className="list card" data-testid="rule-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {rules.map((r) => (
            <li key={r.id}>
              <span className="setting-text"><span><strong>{r.contains}</strong> → {r.category ?? '—'}</span></span>
              <Sheet label="Cambiar" triggerClassName="link small-link" triggerLabel={`Cambiar ${r.contains}`} title={r.contains}
                subtitle="Se aplica a los próximos movimientos; los ya registrados no cambian.">
                <div className="sheet-body stack">
                  <ActionForm action={changeRuleAction} label={`Cambiar regla ${r.contains}`} closeOnSuccess>
                    <input type="hidden" name="id" value={r.id} />
                    <label className="stack-sm"><span>Categoría</span>
                      <select name="categoryId" defaultValue={categoryId.get(r.category ?? '') ?? ''} required>
                        {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select></label>
                    <button type="submit" className="wide">Guardar</button>
                  </ActionForm>
                  <ActionForm action={deleteRuleAction} className="inline" label={`Eliminar regla ${r.contains}`} closeOnSuccess>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="link" style={{ color: 'var(--semantic-error)' }}>Olvidar este comercio</button>
                  </ActionForm>
                </div>
              </Sheet>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Tus correcciones siempre tienen prioridad sobre lo que Velsuno recuerda.</p>

      {confirmed.length > 0 && (
        <section className="stack-sm" aria-labelledby="links">
          <h2 id="links">Pagos e ingresos resueltos</h2>
          <ul className="list card" data-testid="settlement-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {confirmed.map((l) => {
              const name = l.fixed_expense?.name ?? l.income?.name ?? 'Pago';
              return (
                <li key={l.id}>
                  <span className="setting-text"><span>{name} · {periodLabel(l.period, l.income?.frequency)}</span>
                    <small className="muted">{l.status === 'skipped' ? 'Omitido' : l.income ? 'Ingreso recibido' : 'Pagado'}{l.tx ? ` · ${formatMoney({ amountMinor: Number(l.tx.amount_minor), currency: l.tx.currency })}` : ''}</small></span>
                  <ActionForm action={unlinkSettlementAction} className="inline" label={`Deshacer ${name} ${l.period}`}>
                    <input type="hidden" name="id" value={l.id} />
                    <button type="submit" className="link small-link">Deshacer</button>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
          <small className="muted">Deshacer no borra el movimiento: solo vuelve a figurar como pendiente.</small>
        </section>
      )}

      {(chat.count ?? 0) > 0 && (
        <section className="stack-sm" aria-labelledby="chat-memory" data-testid="onboarding-memory">
          <h2 id="chat-memory">Conversación de bienvenida</h2>
          <p className="muted small">Tus pagos, ingresos y deudas guardados se quedan. Edítalos en Próximos pagos o Dinero libre.</p>
          <ActionForm action={forgetOnboardingAction} className="inline" label="Borrar conversación de bienvenida">
            <button type="submit" className="link" style={{ color: 'var(--semantic-error)' }}>Borrar conversación</button>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
