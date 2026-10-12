import { ActionForm } from './action-form';
import { Sheet } from './ui/sheet';
import { createCategoryAction, deleteCategoryAction, renameCategoryAction } from '../app/app/actions';

/** Your own categories (labels). The type of a movement keeps its financial meaning whatever the category. */
export function CategoriesSheet({ categories }: { categories: ReadonlyArray<{ id: string; name: string; own: boolean }> }) {
  const own = categories.filter((c) => c.own);
  return (
    <Sheet label="Categorías" triggerClassName="button quiet" title="Tus categorías" testId="categories-sheet"
      subtitle="Agrupa tus gastos como prefieras.">
      <div className="sheet-body stack">
        <ActionForm action={createCategoryAction} label="Nueva categoría">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="stack-sm" style={{ flex: 1 }}><span>Nueva categoría</span><input name="name" required maxLength={40} placeholder="Mascotas" /></label>
            <button type="submit">Agregar</button>
          </div>
        </ActionForm>
        {own.length > 0 && (
          <ul className="list" data-testid="own-categories">
            {own.map((c) => (
              <li key={c.id}>
                <ActionForm action={renameCategoryAction} label={`Renombrar ${c.name}`} className="row" >
                  <input type="hidden" name="id" value={c.id} />
                  <input name="name" defaultValue={c.name} maxLength={40} aria-label={`Nombre de ${c.name}`} style={{ flex: 1 }} />
                  <button type="submit" className="link small-link">Guardar</button>
                </ActionForm>
                <ActionForm action={deleteCategoryAction} className="inline" label={`Quitar ${c.name}`}>
                  <input type="hidden" name="id" value={c.id} />
                  <button type="submit" className="link small-link muted-link">Quitar</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <details><summary>Categorías de Velsuno</summary>
          <p className="muted small" style={{ paddingTop: 8 }}>{categories.filter((c) => !c.own).map((c) => c.name).join(' · ')}</p>
        </details>
      </div>
    </Sheet>
  );
}
