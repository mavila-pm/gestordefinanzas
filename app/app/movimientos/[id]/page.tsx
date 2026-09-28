import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '../../../../components/action-form';
import { TransactionFields } from '../../../../components/transaction-fields';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { ingestionCodesFor, LINKED_SELECT, loadCatalog, toLinked } from '../../../../lib/queries';
import { formatMoney } from '../../../../src/domain/money';
import type { TransactionType } from '../../../../src/domain/types';
import { reviewReasons } from '../../../../src/engine/review-reasons';
import { CORRECTABLE_TYPES, formatLimaDateTime, isoToLimaInputs, isUuid, minorToInput, TYPE_LABEL } from '../../../../src/web/transaction-input';
import { correctAction, createCardAction, deleteTransactionAction, reviewAction, splitAction } from '../../actions';
import { Icon } from '../../../../components/ui/icon';
import { Sheet } from '../../../../components/ui/sheet';
import { SplitEditor } from '../../../../components/split-editor';
import { isSplittable } from '../../../../src/domain/allocations';
import { SOURCE_LABEL } from '../../../../src/web/labels';

const CHANNEL_LABEL: Record<string, string> = { email: 'Notificación por email', sms: 'Notificación por SMS', import: 'Mensaje del banco importado por ti', manual: 'Registrado por ti' };
const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmado', review_required: 'Por revisar', possible_duplicate: 'Posible duplicado', ignored: 'Ignorado' };
const ACTION_LABEL: Record<string, string> = { manual_create: 'Registrado manualmente', confirm: 'Confirmado', ignore: 'Ignorado', correct: 'Corregido', rule_create: 'Regla de comercio creada', card_link: 'Tarjeta asociada', split: 'División actualizada' };
const FIELD_LABEL: Record<string, string> = {
  type: 'Tipo', amount_minor: 'Monto', currency: 'Moneda', occurred_at: 'Fecha', merchant_raw: 'Descripción',
  category_id: 'Categoría', card_id: 'Tarjeta', account_id: 'Cuenta', status: 'Estado',
};

export default async function TransactionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createSupabaseServerClient();
  // RLS: another user's id simply returns no row (same 404 as a non-existent one).
  const { data } = await supabase.from('transactions').select(`${LINKED_SELECT},updated_at`).eq('id', id).maybeSingle();
  if (!data) notFound();
  const t = toLinked(data as never);
  const version = (data as unknown as { updated_at: string }).updated_at;
  const [catalog, codes, audit, allocations] = await Promise.all([
    loadCatalog(supabase),
    ingestionCodesFor(supabase, [t.id]),
    supabase.from('audit_events').select('id,action,changes,created_at').eq('transaction_id', t.id).order('created_at'),
    supabase.from('transaction_allocations').select('category_id,amount_minor,note').eq('transaction_id', t.id).order('position'),
  ]);

  const names = new Map<string, string>([
    ...catalog.categories.map((c) => [c.id, c.name] as const),
    ...catalog.cards.map((c) => [c.id, `${c.alias} ****${c.last4}`] as const),
    ...catalog.accounts.map((a) => [a.id, a.alias] as const),
  ]);
  const show = (field: string, v: unknown, currency: 'PEN' | 'USD'): string => {
    if (v === null || v === undefined) return '—';
    if (field === 'amount_minor') return formatMoney({ amountMinor: Number(v), currency });
    if (field === 'type') return TYPE_LABEL[v as TransactionType] ?? String(v);
    if (field === 'status') return STATUS_LABEL[String(v)] ?? String(v);
    if (field === 'occurred_at') return formatLimaDateTime(String(v));
    if (field.endsWith('_id')) return names.get(String(v)) ?? 'Eliminado';
    return String(v);
  };

  const pending = t.status === 'review_required' || t.status === 'possible_duplicate';
  const activeCards = catalog.cards.filter((c) => c.active);
  const reasons = pending ? reviewReasons(t, { ingestionCodes: codes.get(t.id) ?? [], registeredCardLast4: activeCards.map((c) => c.last4), cardId: t.cardId }) : [];
  const cardUnregistered = !!t.cardLast4 && !activeCards.some((c) => c.last4 === t.cardLast4);
  // A card can only be linked if its digits match the ones the bank reported.
  const linkable = catalog.cards.filter((c) => c.active || c.id === t.cardId);
  const cards = t.cardLast4 ? linkable.filter((c) => c.last4 === t.cardLast4) : linkable;
  const accounts = catalog.accounts.filter((a) => a.active || a.id === t.accountId);
  const manualOnly = t.sources.length > 0 && t.sources.every((s) => s.channel === 'manual');
  const canRemember = ['expense', 'credit_card_purchase', 'refund', 'reversal'].includes(t.type) && !!t.merchantNormalized && t.merchantNormalized.length >= 3;
  // Currency in force before/after each audited change (amounts are shown in the currency they had then).
  const currencyTimeline = (() => {
    const rows = audit.data ?? [];
    const firstChange = rows.find((a) => (a.changes as Record<string, { from: string }>).currency)?.changes as Record<string, { from: 'PEN' | 'USD' }> | undefined;
    let current: 'PEN' | 'USD' = firstChange?.currency?.from ?? t.currency;
    return new Map(rows.map((a) => {
      const c = (a.changes as Record<string, { from: 'PEN' | 'USD'; to: 'PEN' | 'USD' }>).currency;
      const before = current;
      if (c) current = c.to;
      return [a.id, { before, after: current }] as const;
    }));
  })();
  const { date, time } = isoToLimaInputs(t.occurredAt);
  const sign = t.direction === 'inflow' ? '+' : t.direction === 'outflow' ? '−' : '';

  const splittable = isSplittable(t);
  const parts = (allocations.data ?? []).map((a) => ({ categoryId: a.category_id as string, amountMinor: Number(a.amount_minor), note: a.note as string | null }));
  const allocated = parts.reduce((a, p) => a + p.amountMinor, 0);
  const splitCategories = catalog.categories.map((c) => ({ id: c.id, name: c.name }));
  const correction = (
    <ActionForm action={correctAction} label="Corregir movimiento">
      <input type="hidden" name="id" value={t.id} />
      <TransactionFields
        types={CORRECTABLE_TYPES}
        catalog={{ ...catalog, cards, accounts }}
        values={{
          type: t.type === 'unknown' ? '' : t.type, amount: minorToInput(t.amountMinor), currency: t.currency, date, time,
          description: t.merchantRaw ?? '', categoryId: t.categoryId ?? '', cardId: t.cardId ?? '', accountId: t.accountId ?? '',
        }}
      />
      {canRemember && (
        <label className="check">
          <input type="checkbox" name="rememberRule" value="1" />
          <span>Usar esta categoría la próxima vez que aparezca <strong>{t.merchantNormalized}</strong></span>
        </label>
      )}
      <div className="actions">
        {pending
          ? <><button type="submit" name="confirm" value="1">Guardar y confirmar</button><button type="submit" name="confirm" value="0" className="secondary">Solo guardar</button></>
          : <button type="submit" name="confirm" value="0">Guardar cambios</button>}
      </div>
    </ActionForm>
  );

  return (
    <main className="stack narrow-md">
      <Link href={pending ? '/app/revisar' : '/app/movimientos?month=all'} className="section-link" style={{ marginLeft: -4 }}>
        <Icon name="back" size={18} />{pending ? 'Por revisar' : 'Movimientos'}
      </Link>

      <header className="detail-head">
        <h1>{t.merchantRaw ?? TYPE_LABEL[t.type]}</h1>
        <p className={`figure${t.direction === 'inflow' ? ' in' : ''}`}>{sign}{formatMoney(t)}</p>
        <p className="muted">
          {[parts.length ? `Dividido en ${parts.length + (allocated < t.amountMinor ? 1 : 0)} partes` : t.category ?? TYPE_LABEL[t.type],
            formatLimaDateTime(t.occurredAt)].join(' · ')}
        </p>
        <p className="muted small">
          {[t.institution && t.cardLast4 ? `${t.institution} ····${t.cardLast4}` : t.institution, SOURCE_LABEL[t.sources[0]?.channel ?? 'manual']].filter(Boolean).join(' · ')}
          {' '}<span className={`tag${pending ? ' review' : ''}`}>{STATUS_LABEL[t.status]}</span>
        </p>
      </header>

      {pending && (
        <section className="notice warning stack-sm" aria-label="Por qué necesita revisión" style={{ display: 'grid' }}>
          <strong>Necesitamos tu ayuda con este movimiento</strong>
          {reasons.length > 0 && <ul className="reasons">{reasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>}
        </section>
      )}

      <div className="actions">
        {t.status !== 'confirmed' && t.type !== 'unknown' && (
          <ActionForm action={reviewAction} className="inline" label="Confirmar">
            <input type="hidden" name="id" value={t.id} /><input type="hidden" name="action" value="confirm" />
            <button type="submit">Confirmar tal como está</button>
          </ActionForm>
        )}
        {!pending && (
          <Sheet label={<><Icon name="edit" size={18} />Editar</>} triggerClassName="secondary" title="Editar movimiento" testId="edit-sheet"
            subtitle={<>{t.merchantRaw ?? TYPE_LABEL[t.type]} · {sign}{formatMoney(t)}</>}>
            <div className="sheet-body">{correction}</div>
          </Sheet>
        )}
        {splittable && (
          <Sheet label={<><Icon name="split" size={18} />{parts.length ? 'Editar división' : 'Dividir gasto'}</>} triggerClassName="secondary"
            title="Dividir gasto" testId="split-sheet" subtitle={<>{t.merchantRaw ?? TYPE_LABEL[t.type]} · <span className="amount">{formatMoney(t)}</span></>}>
            <SplitEditor action={splitAction} txId={t.id} version={version} amountMinor={t.amountMinor} currency={t.currency}
              ownCategory={t.category ?? 'Sin categoría'} categories={splitCategories} initial={parts} />
          </Sheet>
        )}
        {t.status !== 'ignored' && (!parts.length) && (
          <ActionForm action={reviewAction} className="inline" label="Ignorar">
            <input type="hidden" name="id" value={t.id} /><input type="hidden" name="action" value="ignore" />
            <button type="submit" className={pending ? 'secondary' : 'link'}>{pending ? 'Ignorar' : 'Ignorar movimiento'}</button>
          </ActionForm>
        )}
      </div>

      {parts.length > 0 && (
        <section aria-label="División" data-testid="split-summary">
          <h2>División</h2>
          <dl className="facts">
            {parts.map((p, i) => (
              <div key={i}><dt>{names.get(p.categoryId) ?? 'Categoría'}{p.note ? ` · ${p.note}` : ''}</dt><dd className="amount">{formatMoney({ amountMinor: p.amountMinor, currency: t.currency })}</dd></div>
            ))}
            {allocated < t.amountMinor && <div><dt>{t.category ?? 'Sin categoría'} (restante)</dt><dd className="amount">{formatMoney({ amountMinor: t.amountMinor - allocated, currency: t.currency })}</dd></div>}
          </dl>
          <small className="muted">Es el mismo movimiento de {formatMoney(t)}: solo se reparte entre categorías.</small>
        </section>
      )}

      {cardUnregistered && (
        <section className="card stack">
          <h2>Registrar la tarjeta ****{t.cardLast4}</h2>
          <p className="muted">Solo guardamos un nombre, el tipo y los últimos 4 dígitos. Nunca ingreses el número completo, CVV ni claves.</p>
          <ActionForm action={createCardAction} label="Registrar tarjeta">
            <input type="hidden" name="back" value={t.id} />
            <input type="hidden" name="last4" value={t.cardLast4 ?? ''} />
            <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Visa Signature" /></label>
            <div className="grid">
              <label className="stack-sm"><span>Tipo</span>
                <select name="kind" required defaultValue=""><option value="" disabled>Elige</option><option value="credit">Crédito</option><option value="debit">Débito</option></select></label>
              <label className="stack-sm"><span>Banco</span>
                <select name="institution" defaultValue={t.institution ?? ''}><option value="">Otro</option><option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option></select></label>
              <label className="stack-sm"><span>Moneda principal</span>
                <select name="currency" defaultValue={t.currency}><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
            </div>
            <button type="submit">Registrar tarjeta</button>
          </ActionForm>
        </section>
      )}

      {pending && (
        <section className="card stack" aria-label="Corregir">
          <h2>Corregir</h2>
          {correction}
        </section>
      )}

      <details className="card" data-testid="origin">
        <summary>Origen e historial</summary>
        <div className="stack-sm" style={{ marginTop: 8 }}>
        <h3>Origen</h3>
        <ul className="list">
          {t.sources.map((s, i) => (
            <li key={i}>
              <span>{CHANNEL_LABEL[s.channel]}{(s.channel === 'import' ? ` (${s.parserVersion.includes('SMS') ? 'SMS' : 'email'})` : '')}{s.channel !== 'manual' && s.templateVerification !== 'VERIFIED' ? ' · formato del banco aún en validación' : ''}</span>
              <span className="muted">recibido {formatLimaDateTime(s.receivedAt)}</span>
            </li>
          ))}
        </ul>
        {t.sources.length > 1 && <p className="muted">Llegó por {t.sources.length} vías distintas y se registró una sola vez.</p>}
        {t.duplicateOfId && <p><Link href={`/app/movimientos/${t.duplicateOfId}`}>Ver el movimiento parecido</Link></p>}
        {t.originalTransactionId && <p><Link href={`/app/movimientos/${t.originalTransactionId}`}>Ver la compra original</Link></p>}
        <h3 style={{ marginTop: 16 }}>Historial de cambios</h3>
        {(audit.data ?? []).length === 0 ? <p className="muted">Sin cambios: se mantiene tal como llegó.</p> : (
          <ul className="list" data-testid="audit-list">
            {(audit.data ?? []).map((a) => (
              <li key={a.id}>
                <span>
                  <strong>{ACTION_LABEL[a.action] ?? a.action}</strong><br />
                  {a.action === 'split' && (() => { const to = ((a.changes as { allocations?: { to?: unknown[] } }).allocations?.to ?? []).length;
                    return <small className="muted" style={{ display: 'block' }}>{to ? `Dividido en ${to} parte(s)` : 'División quitada'}</small>; })()}
                  {a.action === 'correct' && Object.entries(a.changes as Record<string, { from: unknown; to: unknown }>).map(([f, c]) => (
                    <small key={f} className="muted" style={{ display: 'block' }}>{FIELD_LABEL[f] ?? f}: {show(f, c.from, currencyTimeline.get(a.id)?.before ?? t.currency)} → {show(f, c.to, currencyTimeline.get(a.id)?.after ?? t.currency)}</small>
                  ))}
                </span>
                <small className="muted">{formatLimaDateTime(a.created_at)}</small>
              </li>
            ))}
          </ul>
        )}
        </div>
      </details>
      {manualOnly && (
        <section className="stack-sm" aria-label="Eliminar">
          <h2>Eliminar</h2>
          <p className="muted">Solo los movimientos que registraste tú se pueden eliminar. Queda constancia en tu historial.</p>
          <ActionForm action={deleteTransactionAction} label="Eliminar movimiento">
            <input type="hidden" name="id" value={t.id} />
            <label className="check"><input type="checkbox" name="confirmDelete" value="1" /> <span>Confirmo que quiero eliminarlo</span></label>
            <button type="submit" className="danger">Eliminar movimiento</button>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
