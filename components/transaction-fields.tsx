import type { Catalog } from '../lib/queries';
import type { TransactionType } from '../src/domain/types';
import { TYPE_LABEL } from '../src/web/transaction-input';

export interface FieldValues {
  type: TransactionType | '';
  amount: string;
  currency: string;
  date: string;
  time: string;
  description: string;
  categoryId: string;
  cardId: string;
  accountId: string;
}

/** Shared inputs for manual entry and correction. Server-validated; these attributes only help the user. */
export function TransactionFields({ types, catalog, values }: { types: readonly TransactionType[]; catalog: Catalog; values: FieldValues }) {
  return (
    <>
      <label className="stack-sm"><span>Tipo de movimiento</span>
        <select name="type" required defaultValue={values.type}>
          {values.type === '' && <option value="" disabled>Elige el tipo</option>}
          {types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </label>
      <p className="muted small">Pagar la tarjeta o retirar efectivo no es gasto. El gasto es cada compra.</p>
      <div className="grid">
        <label className="stack-sm"><span>Monto</span>
          <input name="amount" required inputMode="decimal" pattern="\d+(\.\d{1,2})?|\d{1,3}(,\d{3})+(\.\d{1,2})?" placeholder="82.50" defaultValue={values.amount} /></label>
        <label className="stack-sm"><span>Moneda</span>
          <select name="currency" defaultValue={values.currency}><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
        <label className="stack-sm"><span>Fecha</span><input name="date" type="date" required defaultValue={values.date} /></label>
        <label className="stack-sm"><span>Hora</span><input name="time" type="time" defaultValue={values.time} /></label>
      </div>
      <label className="stack-sm"><span>Descripción o comercio</span>
        <input name="description" maxLength={120} placeholder="Ej. Almuerzo, Uber, Sueldo" defaultValue={values.description} /></label>
      <label className="stack-sm"><span>Categoría <small className="muted">(solo gastos y devoluciones)</small></span>
        <select name="categoryId" defaultValue={values.categoryId}>
          <option value="">Automática</option>
          {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="grid">
        <label className="stack-sm"><span>Tarjeta</span>
          <select name="cardId" defaultValue={values.cardId}>
            <option value="">Sin tarjeta</option>
            {catalog.cards.map((c) => <option key={c.id} value={c.id}>{c.alias} ****{c.last4} ({c.kind === 'credit' ? 'crédito' : 'débito'})</option>)}
          </select>
        </label>
        {catalog.accounts.length > 0 && (
          <label className="stack-sm"><span>Cuenta</span>
            <select name="accountId" defaultValue={values.accountId}>
              <option value="">Sin cuenta</option>
              {catalog.accounts.map((a) => <option key={a.id} value={a.id}>{a.alias}{a.last4 ? ` ****${a.last4}` : ''}</option>)}
            </select>
          </label>
        )}
      </div>
    </>
  );
}
