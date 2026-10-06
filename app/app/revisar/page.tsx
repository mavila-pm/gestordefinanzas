import Link from 'next/link';
import { plural } from '../../../src/domain/plural';
import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { ingestionCodesFor, LINKED_SELECT, loadCatalog, REVIEW_STATUSES, toLinked } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { reviewReasons } from '../../../src/engine/review-reasons';
import { formatLimaDateTime, TYPE_LABEL } from '../../../src/web/transaction-input';
import { reviewAction } from '../actions';
import { Icon } from '../../../components/ui/icon';

import { SOURCE_LABEL } from '../../../src/web/labels';

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

  return (
    <main className="stack">
      <div className="page-head">
        <h1>Por revisar</h1>
        <p>{txs.length ? `${plural(txs.length, 'movimiento espera', 'movimientos esperan')} tu confirmación. No cuentan hasta que los confirmes.` : 'Lo que no esté claro llegará aquí.'}</p>
      </div>
      {txs.length === 0 ? <p className="notice positive"><Icon name="check" />Todo al día. No hay nada por revisar.</p> : (
        <ul className="stack plain" data-testid="review-list">
          {txs.map((t) => {
            const reasons = reviewReasons(t, { ingestionCodes: codes.get(t.id) ?? [], registeredCardLast4: cardLast4, cardId: t.cardId });
            const sign = t.direction === 'inflow' ? '+' : t.direction === 'outflow' ? '−' : '';
            return (
              <li key={t.id} className="card stack-sm review-card" data-testid="review-item">
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <strong className="review-name">{t.merchantRaw ?? TYPE_LABEL[t.type]}</strong>
                  <span className="amount big">{sign}{formatMoney(t)}</span>
                </div>
                <small className="muted">
                  {[TYPE_LABEL[t.type], formatLimaDateTime(t.occurredAt), t.institution && t.cardLast4 ? `${t.institution} ····${t.cardLast4}` : t.institution,
                    SOURCE_LABEL[t.sources[0]?.channel ?? 'manual']].filter(Boolean).join(' · ')}
                </small>
                <ul className="reasons why" aria-label="Por qué necesita revisión">
                  {reasons.map((r) => <li key={r.code} data-reason={r.code}>{r.text}</li>)}
                </ul>
                {t.duplicateOfId && <small><Link href={`/app/movimientos/${t.duplicateOfId}`}>Ver el movimiento parecido</Link></small>}
                <div className="actions">
                  {t.type !== 'unknown' && (
                    <ActionForm action={reviewAction} className="inline" label="Confirmar">
                      <input type="hidden" name="id" value={t.id} />
                      <input type="hidden" name="action" value="confirm" />
                      <button type="submit">{t.status === 'possible_duplicate' ? 'No es duplicado, confirmar' : 'Confirmar'}</button>
                    </ActionForm>
                  )}
                  <Link className="button secondary" href={`/app/movimientos/${t.id}`}>Corregir / ver origen</Link>
                  <ActionForm action={reviewAction} className="inline" label="Ignorar">
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="action" value="ignore" />
                    <button type="submit" className="link">{t.status === 'possible_duplicate' ? 'Es duplicado, ignorar' : 'Ignorar'}</button>
                  </ActionForm>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
