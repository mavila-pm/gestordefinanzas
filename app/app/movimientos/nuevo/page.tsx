import { randomUUID } from 'node:crypto';
import { ActionForm } from '../../../../components/action-form';
import { TransactionFields } from '../../../../components/transaction-fields';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { loadCatalog } from '../../../../lib/queries';
import { isoToLimaInputs, MANUAL_TYPES } from '../../../../src/web/transaction-input';
import { createManualAction } from '../../actions';

export default async function NewTransaction({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const { ok } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const catalog = await loadCatalog(supabase);
  const { date, time } = isoToLimaInputs(new Date().toISOString());
  // One reference per rendered form: a double submit or retry creates the movement only once.
  const clientRef = randomUUID();

  return (
    <main className="stack narrow-md">
      <h1>Nuevo movimiento</h1>
      {ok === '1' && <p role="status" className="ok">Movimiento registrado. Puedes registrar otro.</p>}
      <section className="card">
        <ActionForm action={createManualAction} label="Registrar movimiento">
          <input type="hidden" name="clientRef" value={clientRef} />
          <TransactionFields
            types={MANUAL_TYPES}
            catalog={catalog}
            values={{ type: 'expense', amount: '', currency: 'PEN', date, time, description: '', categoryId: '', cardId: '', accountId: '' }}
          />
          <button type="submit">Registrar</button>
        </ActionForm>
      </section>
    </main>
  );
}
