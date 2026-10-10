import Link from 'next/link';
import { plural } from '../../../src/domain/plural';
import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { ingestionCodesFor, LINKED_SELECT, loadCatalog, REVIEW_STATUSES, toLinked } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { reviewReasons } from '../../../src/engine/review-reasons';
import { TYPE_LABEL } from '../../../src/web/transaction-input';
import { reviewAction } from '../actions';
import { Icon } from '../../../components/ui/icon';

import { limaDateKey, SOURCE_LABEL } from '../../../src/web/labels';
import { shortDate } from '../../../src/domain/dates';

export const metadata = { title: 'Por revisar' };

export default async function ReviewQueue() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('transactions')
    .select(LINKED_SELECT)
    .in('status', [...REVIEW_STATUSES])
    .order('occurred_at', { ascending: false })
    .limit(100);
  if (error) return <main className="stack"><p role="alert" className="error">No se pudo cargar la bandeja.</p></main>;

  const txs = (data as never[]).map(toLinked);
  const [codes, catalog] = await Promise.all([ingestionCodesFor(supabase, txs.map((t) => t.id)), loadCatalog(supabase)]);
  const cardLast4 = catalog.cards.filter((c) => c.active).map((c) => c.last4);

  const accountName = new Map([...catalog.accounts.map((a) => [a.id, a.alias] as const), ...catalog.cards.map((c) => [c.id, c.alias] as const)]);

  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Por revisar</h1>
        <p>{txs.length ? `${plural(txs.length, 'movimiento espera', 'movimientos esperan')} tu confirmación.` : 'Todo al día.'}</p>
      </div>
      {txs.length === 0 ? <p className="notice positive"><Icon name="check" />No hay nada por revisar.</p> : (
        <ul className="stack-sm plain" data-testid="review-list">
          {txs.map((t) => {
            const reasons = reviewReasons(t, { ingestionCodes: codes.get(t.id) ?? [], registeredCardLast4: cardLast4, cardId: t.cardId });
            const sign = t.direction === 'inflow' ? '+' : t.direction === 'outflow' ? '−' : '';
            const origin = (t.cardId && accountName.get(t.cardId)) || (t.accountId && accountName.get(t.accountId))
              || (t.institution ? `${t.institution}${t.cardLast4 ? ` ····${t.cardLast4}` : ''}` : SOURCE_LABEL[t.sources[0]?.channel ?? 'manual']);
            const dup = t.status === 'possible_duplicate';
            return (
              <li key={t.id} className="card review-card" data-testid="review-item">
                <div className="review-top">
                  <span className="amount big">{sign}{formatMoney(t)}</span>
                  {dup && <span className="tag review">Posible duplicado</span>}
                </div>
                <strong className="review-name">{t.merchantRaw ?? 'Sin comercio'}</strong>
                <small className="muted">{shortDate(limaDateKey(t.occurredAt))} · {origin}</small>
                <dl className="review-facts">
                  <div><dt>Tipo</dt><dd>{t.type === 'unknown' ? <span className="warn">Por definir</span> : TYPE_LABEL[t.type]}</dd></div>
                  <div><dt>Categoría</dt><dd>{t.category ?? <span className="muted">Sin categoría</span>}</dd></div>
                </dl>
                {reasons[0] && <small className="muted why" data-reason={reasons[0].code}>{reasons[0].text}</small>}
                {t.duplicateOfId && <small><Link href={`/app/movimientos/${t.duplicateOfId}`}>Ver el movimiento parecido</Link></small>}
                <div className="actions">
                  {t.type !== 'unknown' && (
                    <ActionForm action={reviewAction} className="inline" label="Confirmar">
                      <input type="hidden" name="id" value={t.id} />
                      <input type="hidden" name="action" value="confirm" />
                      <button type="submit">{dup ? 'No es duplicado' : 'Confirmar'}</button>
                    </ActionForm>
                  )}
                  <Link className="button secondary" href={`/app/movimientos/${t.id}`}>Editar</Link>
                  {dup && (
                    <ActionForm action={reviewAction} className="inline" label="Es duplicado">
                      <input type="hidden" name="id" value={t.id} />
                      <input type="hidden" name="action" value="ignore" />
                      <button type="submit" className="link">Es duplicado</button>
                    </ActionForm>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
