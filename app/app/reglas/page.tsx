import { ActionForm } from '../../../components/action-form';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadCatalog, loadRules } from '../../../lib/queries';
import { changeRuleAction, deleteRuleAction } from '../actions';

export const metadata = { title: 'Lo que Velsuno recuerda' };

export default async function Rules() {
  const supabase = await createSupabaseServerClient();
  const [rules, catalog] = await Promise.all([loadRules(supabase), loadCatalog(supabase)]);
  const categoryId = new Map(catalog.categories.map((c) => [c.name, c.id]));
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Lo que Velsuno recuerda</h1>
        <p>Cuando corriges una categoría y marcas “usar la próxima vez”, la recordamos para ese comercio.</p>
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
    </main>
  );
}
