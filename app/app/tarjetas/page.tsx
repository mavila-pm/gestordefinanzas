import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadCatalog } from '../../../lib/queries';
import { createCardAction } from '../actions';

export default async function Cards() {
  const supabase = await createSupabaseServerClient();
  const { cards } = await loadCatalog(supabase);
  return (
    <main className="stack narrow-md">
      <h1>Tarjetas</h1>
      <section className="card stack-sm">
        {cards.length === 0 ? <p className="muted">Aún no registras tarjetas.</p> : (
          <ul className="list" data-testid="card-list">
            {cards.map((c) => (
              <li key={c.id}><span>{c.alias}<br /><small className="muted">{[c.institution, c.kind === 'credit' ? 'Crédito' : 'Débito', c.currency].filter(Boolean).join(' · ')}</small></span><span>****{c.last4}</span></li>
            ))}
          </ul>
        )}
      </section>
      <section className="card stack">
        <h2>Registrar tarjeta</h2>
        <p className="muted">Solo guardamos un nombre, el tipo y los últimos 4 dígitos. Nunca ingreses el número completo, CVV, PIN ni claves.</p>
        <ActionForm action={createCardAction} label="Registrar tarjeta">
          <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Visa Signature" /></label>
          <div className="grid">
            <label className="stack-sm"><span>Últimos 4 dígitos</span><input name="last4" required inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" /></label>
            <label className="stack-sm"><span>Tipo</span>
              <select name="kind" required defaultValue=""><option value="" disabled>Elige</option><option value="credit">Crédito</option><option value="debit">Débito</option></select></label>
            <label className="stack-sm"><span>Banco</span>
              <select name="institution" defaultValue="BCP"><option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="">Otro</option></select></label>
            <label className="stack-sm"><span>Moneda principal</span>
              <select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
          </div>
          <button type="submit">Registrar tarjeta</button>
        </ActionForm>
      </section>
    </main>
  );
}
