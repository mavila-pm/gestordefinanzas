import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadRules } from '../../../lib/queries';
import { formatLimaDateTime } from '../../../src/web/transaction-input';
import { deleteRuleAction } from '../actions';

export default async function Rules() {
  const supabase = await createSupabaseServerClient();
  const rules = await loadRules(supabase);
  return (
    <main className="stack narrow-md">
      <h1>Reglas de comercios</h1>
      <p className="muted">Se crean cuando corriges la categoría de un movimiento y marcas “Recordar”. Se aplican a los próximos
        movimientos de ese comercio; los ya registrados no cambian. Tus correcciones siempre tienen prioridad.</p>
      <section className="card">
        {rules.length === 0 ? <p className="muted">Aún no tienes reglas.</p> : (
          <ul className="list" data-testid="rule-list">
            {rules.map((r) => (
              <li key={r.id}>
                <span><strong>{r.contains}</strong> → {r.category ?? '—'}<br /><small className="muted">desde {formatLimaDateTime(r.createdAt)}</small></span>
                <ActionForm action={deleteRuleAction} className="inline" label={`Eliminar regla ${r.contains}`}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" className="link">Eliminar</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
