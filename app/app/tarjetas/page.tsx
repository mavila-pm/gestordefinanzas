import { ActionForm } from '../../../components/action-form';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { activeOnly, loadCatalog } from '../../../lib/queries';
import { createAccountAction, createCardAction, deactivateAction } from '../actions';

export const metadata = { title: 'Cuentas y tarjetas' };
const BANKS = <><option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="">Otro</option></>;
const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;

function Options({ id, kind, name, detail }: { id: string; kind: 'card' | 'account'; name: string; detail: string }) {
  return (
    <Sheet label={<Icon name="more" />} triggerClassName="icon" triggerLabel={`Opciones de ${name}`} title={name} subtitle={detail}>
      <div className="sheet-body stack-sm">
        <p className="muted small">Si la desactivas deja de usarse para reconocer movimientos nuevos. Tu historial no cambia.</p>
        <ActionForm action={deactivateAction} className="inline" label={`Desactivar ${name}`} closeOnSuccess>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="kind" value={kind} />
          <button type="submit" className="danger wide">Desactivar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

export default async function CardsAndAccounts() {
  const supabase = await createSupabaseServerClient();
  const catalog = await loadCatalog(supabase);
  const cards = activeOnly(catalog.cards);
  const accounts = activeOnly(catalog.accounts);
  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Cuentas y tarjetas</h1>
        <p>Con ellas reconocemos tus compras y tus transferencias entre cuentas propias.</p>
      </div>

      <section className="stack-sm" aria-labelledby="h-acc">
        <h2 id="h-acc">Cuentas</h2>
        {accounts.length === 0 ? <p className="muted">Aún no agregas cuentas. Agrega las tuyas para que una transferencia entre ellas no cuente como gasto.</p> : (
          <ul className="list card" data-testid="account-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {accounts.map((a) => {
              const detail = [a.institution ?? 'Otro banco', a.currency === 'USD' ? 'Dólares' : 'Soles'].join(' · ');
              return (
                <li key={a.id}>
                  <span className="setting-text"><span>{a.alias}{a.last4 ? ` ****${a.last4}` : ''}</span>
                    <small className="muted">{detail}{a.last4 ? '' : ' · sin dígitos: no detecta transferencias'}</small></span>
                  <Options id={a.id} kind="account" name={a.alias} detail={detail} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="stack-sm" aria-labelledby="h-cards">
        <h2 id="h-cards">Tarjetas</h2>
        {cards.length === 0 ? <p className="muted">Aún no agregas tarjetas. Con una tarjeta de crédito registrada, sus compras se confirman solas.</p> : (
          <ul className="list card" data-testid="card-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {cards.map((c) => {
              const detail = [c.institution, c.kind === 'credit' ? 'Crédito' : 'Débito', c.currency === 'USD' ? 'Dólares' : 'Soles'].filter(Boolean).join(' · ');
              return (
                <li key={c.id}>
                  <span className="setting-text"><span>{c.alias} ****{c.last4}</span><small className="muted">{detail}</small></span>
                  <Options id={c.id} kind="card" name={c.alias} detail={detail} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="actions">
        <Sheet label={<><Icon name="add" size={18} />Agregar cuenta</>} triggerClassName="quiet" title="Nueva cuenta" subtitle="Solo el nombre y los últimos 4 dígitos." testId="account-sheet">
          <div className="sheet-body">
            <ActionForm action={createAccountAction} label="Registrar cuenta" closeOnSuccess>
              <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Ahorros BBVA" /></label>
              <div className="grid">
                <label className="stack-sm"><span>Últimos 4 dígitos</span><input name="last4" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" /></label>
                <label className="stack-sm"><span>Banco</span><select name="institution" defaultValue="BCP">{BANKS}</select></label>
                <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
              </div>
              <button type="submit" className="wide">Agregar cuenta</button>
            </ActionForm>
          </div>
        </Sheet>
        <Sheet label={<><Icon name="add" size={18} />Agregar tarjeta</>} triggerClassName="quiet" title="Nueva tarjeta" subtitle="Nunca pongas el número completo, CVV, PIN ni claves." testId="card-sheet">
          <div className="sheet-body">
            <ActionForm action={createCardAction} label="Registrar tarjeta" closeOnSuccess>
              <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Visa Signature" /></label>
              <div className="grid">
                <label className="stack-sm"><span>Últimos 4 dígitos</span><input name="last4" required inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" /></label>
                <label className="stack-sm"><span>Tipo</span>
                  <select name="kind" required defaultValue=""><option value="" disabled>Elige</option><option value="credit">Crédito</option><option value="debit">Débito</option></select></label>
                <label className="stack-sm"><span>Banco</span><select name="institution" defaultValue="BCP">{BANKS}</select></label>
                <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
              </div>
              <button type="submit" className="wide">Agregar tarjeta</button>
            </ActionForm>
          </div>
        </Sheet>
      </div>
    </main>
  );
}
