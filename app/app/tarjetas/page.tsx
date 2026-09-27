import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { activeOnly, loadCatalog } from '../../../lib/queries';
import { createAccountAction, createCardAction, deactivateAction } from '../actions';

const BANKS = (
  <>
    <option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="">Otro</option>
  </>
);

export default async function CardsAndAccounts() {
  const supabase = await createSupabaseServerClient();
  const catalog = await loadCatalog(supabase);
  const cards = activeOnly(catalog.cards);
  const accounts = activeOnly(catalog.accounts);
  return (
    <main className="stack narrow-md">
      <h1>Tarjetas y cuentas</h1>
      <p className="muted">Registrarlas ayuda a clasificar solo: una compra con tarjeta de crédito registrada se confirma sin revisión,
        y una transferencia a una cuenta tuya no cuenta como gasto. Solo guardamos alias, tipo, moneda y los últimos 4 dígitos.</p>

      <section className="card stack-sm">
        <h2>Tarjetas</h2>
        {cards.length === 0 ? <p className="muted">Aún no registras tarjetas.</p> : (
          <ul className="list" data-testid="card-list">
            {cards.map((c) => (
              <li key={c.id}>
                <span>{c.alias} ****{c.last4}<br /><small className="muted">{[c.institution, c.kind === 'credit' ? 'Crédito' : 'Débito', c.currency].filter(Boolean).join(' · ')}</small></span>
                <ActionForm action={deactivateAction} className="inline" label={`Desactivar ${c.alias}`}>
                  <input type="hidden" name="id" value={c.id} /><input type="hidden" name="kind" value="card" />
                  <button type="submit" className="link">Desactivar</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary>Registrar tarjeta</summary>
          <p className="muted small">Nunca ingreses el número completo, CVV, PIN ni claves.</p>
          <ActionForm action={createCardAction} label="Registrar tarjeta">
            <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Visa Signature" /></label>
            <div className="grid">
              <label className="stack-sm"><span>Últimos 4 dígitos</span><input name="last4" required inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" /></label>
              <label className="stack-sm"><span>Tipo</span>
                <select name="kind" required defaultValue=""><option value="" disabled>Elige</option><option value="credit">Crédito</option><option value="debit">Débito</option></select></label>
              <label className="stack-sm"><span>Banco</span><select name="institution" defaultValue="BCP">{BANKS}</select></label>
              <label className="stack-sm"><span>Moneda principal</span>
                <select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
            </div>
            <button type="submit">Registrar tarjeta</button>
          </ActionForm>
        </details>
      </section>

      <section className="card stack-sm">
        <h2>Cuentas propias</h2>
        {accounts.length === 0 ? <p className="muted">Aún no registras cuentas.</p> : (
          <ul className="list" data-testid="account-list">
            {accounts.map((a) => (
              <li key={a.id}>
                <span>{a.alias}{a.last4 ? ` ****${a.last4}` : ''}<br /><small className="muted">{[a.institution, a.currency, a.last4 ? null : 'sin dígitos: no se usa para detectar transferencias propias'].filter(Boolean).join(' · ')}</small></span>
                <ActionForm action={deactivateAction} className="inline" label={`Desactivar ${a.alias}`}>
                  <input type="hidden" name="id" value={a.id} /><input type="hidden" name="kind" value="account" />
                  <button type="submit" className="link">Desactivar</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary>Registrar cuenta</summary>
          <ActionForm action={createAccountAction} label="Registrar cuenta">
            <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Ahorros BBVA" /></label>
            <div className="grid">
              <label className="stack-sm"><span>Últimos 4 dígitos (recomendado)</span><input name="last4" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" /></label>
              <label className="stack-sm"><span>Banco</span><select name="institution" defaultValue="BCP">{BANKS}</select></label>
              <label className="stack-sm"><span>Moneda</span>
                <select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
            </div>
            <button type="submit">Registrar cuenta</button>
          </ActionForm>
        </details>
      </section>
    </main>
  );
}
