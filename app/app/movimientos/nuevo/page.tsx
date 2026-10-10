import { randomUUID } from 'node:crypto';
import { ActionForm } from '../../../../components/action-form';
import { TransactionFields } from '../../../../components/transaction-fields';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { activeOnly, loadCatalog } from '../../../../lib/queries';
import { loadPreferences } from '../../../../lib/preferences';
import { isoToLimaInputs, MANUAL_TYPES } from '../../../../src/web/transaction-input';
import { createManualAction } from '../../actions';

export const metadata = { title: 'Nuevo movimiento' };

export default async function NewTransaction({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const { ok } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [catalog, prefs] = await Promise.all([loadCatalog(supabase), loadPreferences(supabase)]);
  // Ajustes → Finanzas: the main currency and account are proposed; the person can change them here.
  const account = activeOnly(catalog.accounts).find((a) => a.id === prefs.primaryAccountId) ?? null;
  const { date, time } = isoToLimaInputs(new Date().toISOString());
  // One reference per rendered form: a double submit or retry creates the movement only once.
  const clientRef = randomUUID();

  return (
    <main className="stack narrow-md">
      <h1>Nuevo movimiento</h1>
      {ok === '1' && <p role="status" className="notice positive">Movimiento registrado. Puedes registrar otro.</p>}
      <section className="card">
        <ActionForm action={createManualAction} label="Registrar movimiento">
          <input type="hidden" name="clientRef" value={clientRef} />
          <TransactionFields
            types={MANUAL_TYPES}
            catalog={{ ...catalog, cards: activeOnly(catalog.cards), accounts: activeOnly(catalog.accounts) }}
            values={{ type: 'expense', amount: '', currency: account?.currency ?? prefs.primaryCurrency, date, time, description: '', categoryId: '', cardId: '', accountId: account?.id ?? '' }}
          />
          <button type="submit" className="wide">Registrar</button>
        </ActionForm>
      </section>
    </main>
  );
}
