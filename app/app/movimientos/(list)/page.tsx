import Link from 'next/link';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';
import { LINKED_SELECT, loadCatalog, loadEntitlements, toLinked } from '../../../../lib/queries';
import { historyStart, visibleMonth } from '../../../../src/domain/entitlements';
import { formatMoney } from '../../../../src/domain/money';
import { limaMonth, limaMonthRange } from '../../../../src/web/auth-input';
import {
  filtersToQuery, KIND_TYPES, PAGE_SIZE, parseMovementFilters, searchAmountMinor, SOURCE_VALUES, STATUS_VALUES,
} from '../../../../src/web/movement-filters';
import { TxRow } from '../../../../components/tx-row';
import { Icon } from '../../../../components/ui/icon';
import { CategoriesSheet } from '../../../../components/categories-sheet';
import { RegisterMenu } from '../../../../components/register-menu';
import { plural } from '../../../../src/domain/plural';
import { limaDateKey, limaDayLabel, monthLabel } from '../../../../src/web/labels';

export const metadata = { title: 'Movimientos' };

export default async function Movements({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const current = limaMonth();
  const supabase = await createSupabaseServerClient();
  const [catalog, { entitlements }] = await Promise.all([loadCatalog(supabase), loadEntitlements(supabase)]);
  // Free history window (§81), applied in the query: older movements are kept but not listed (export keeps them all).
  const firstMonth = historyStart(entitlements, current);
  const parsed = parseMovementFilters(await searchParams, current);
  const f = parsed.month === 'all' ? parsed : { ...parsed, month: visibleMonth(parsed.month, firstMonth) };

  // Every filter is applied server-side under RLS; values come from fixed whitelists (movement-filters.ts).
  const select = f.source === 'all' ? LINKED_SELECT : `${LINKED_SELECT},src_filter:transaction_sources!inner(channel)`;
  let q = supabase.from('transactions').select(select, { count: 'exact' });
  if (f.month !== 'all') { const r = limaMonthRange(f.month)!; q = q.gte('occurred_at', r.from).lt('occurred_at', r.to); }
  else if (firstMonth) q = q.gte('occurred_at', limaMonthRange(firstMonth)!.from);
  if (f.status !== 'all') q = q.in('status', STATUS_VALUES[f.status]);
  if (f.kind !== 'all') q = q.in('type', KIND_TYPES[f.kind]);
  if (f.source !== 'all') q = q.in('src_filter.channel', SOURCE_VALUES[f.source]);
  if (f.categoryId) q = q.eq('category_id', f.categoryId);
  if (f.currency !== 'all') q = q.eq('currency', f.currency);
  const amount = f.q ? searchAmountMinor(f.q) : null;
  // f.q is whitelisted (sanitizeSearch) and the amount is an integer, so the or() filter cannot be injected.
  if (f.q) q = amount ? q.or(`amount_minor.eq.${amount},merchant_raw.ilike.*${f.q}*`) : q.ilike('merchant_raw', `%${f.q}%`);
  const from = (f.page - 1) * PAGE_SIZE;
  const { data, count, error } = await q.order('occurred_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
  const txs = error ? [] : (data as never[]).map(toLinked);
  const total = count ?? 0;

  const opt = (value: string, label: string) => <option key={value} value={value}>{label}</option>;
  const activeFilters = [f.status !== 'all', f.kind !== 'all', f.source !== 'all', !!f.categoryId, f.currency !== 'all'].filter(Boolean).length;
  const days: Array<[string, typeof txs]> = [];
  for (const t of txs) {
    const key = limaDateKey(t.occurredAt);
    const last = days.at(-1);
    if (last && last[0] === key) last[1].push(t); else days.push([key, [t]]);
  }
  return (
    <main className="stack">
      <header className="row">
        <div className="page-head">
          <h1>Movimientos</h1>
          <p data-testid="movement-count">{plural(total, 'movimiento', 'movimientos')}{f.month !== 'all' ? ` en ${monthLabel(f.month).toLowerCase()}` : ''}</p>
        </div>
        <div className="actions">
          <CategoriesSheet categories={catalog.categories} />
          <RegisterMenu className="button" />
        </div>
      </header>

      <form method="get" aria-label="Filtros" className="stack-sm" style={{ gap: 12 }}>
        <div className="search">
          <label className="sr-only" htmlFor="q">Buscar por comercio o monto</label>
          <Icon name="search" />
          <input id="q" name="q" type="search" defaultValue={f.q} maxLength={60} placeholder="Buscar comercio o monto" enterKeyHint="search" />
        </div>
        <details open={activeFilters > 0} className="filters-box">
          <summary>Filtros{activeFilters > 0 ? ` (${activeFilters})` : ''}</summary>
          <div className="filters">
            <label className="stack-sm"><span>Mes</span><input name="month" type="month" min={firstMonth ?? undefined} max={current} defaultValue={f.month === 'all' ? '' : f.month} /></label>
            <label className="stack-sm"><span>Estado</span><select name="status" defaultValue={f.status}>
              {opt('all', 'Todos')}{opt('confirmed', 'Confirmados')}{opt('pending', 'Por revisar')}{opt('ignored', 'Ignorados')}</select></label>
            <label className="stack-sm"><span>Tipo</span><select name="kind" defaultValue={f.kind}>
              {opt('all', 'Todos')}{opt('expense', 'Gastos')}{opt('income', 'Ingresos')}{opt('internal', 'Pagos de tarjeta y transferencias propias')}
              {opt('withdrawal', 'Retiros de efectivo')}{opt('refund', 'Devoluciones y reversos')}{opt('unknown', 'Sin determinar')}</select></label>
            <label className="stack-sm"><span>Origen</span><select name="source" defaultValue={f.source}>
              {opt('all', 'Todos')}{opt('auto', 'Automático')}{opt('import', 'Mensaje pegado')}{opt('manual', 'Manual')}</select></label>
            <label className="stack-sm"><span>Categoría</span><select name="category" defaultValue={f.categoryId ?? ''}>
              <option value="">Todas</option>{catalog.categories.map((c) => opt(c.id, c.name))}</select></label>
            <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue={f.currency}>
              {opt('all', 'Todas')}{opt('PEN', 'Soles')}{opt('USD', 'Dólares')}</select></label>
          </div>
        </details>
        <div className="actions">
          <button type="submit">Aplicar</button>
          {(activeFilters > 0 || f.q || f.month !== 'all') && <Link href="/app/movimientos?month=all" className="button secondary">Ver todo</Link>}
        </div>
      </form>

      {firstMonth && entitlements.limits.historyMonths !== null && (
        <p className="muted small" data-testid="history-window">
          Tu plan actual (Free) muestra los movimientos {entitlements.limits.historyMonths === 1 ? 'de este mes' : `de los últimos ${entitlements.limits.historyMonths} meses`}. Para consultar otros meses, <Link href="/app/ajustes/plan">cambia a Plus</Link>.
        </p>
      )}
      <section aria-label="Lista de movimientos">
        {error && <p role="alert" className="notice error">No pudimos cargar los movimientos. Intenta de nuevo.</p>}
        {!error && txs.length === 0 && <p className="muted">{f.q ? `Nada coincide con “${f.q}”.` : `Aún no hay movimientos${f.month !== 'all' ? ` en ${monthLabel(f.month).toLowerCase()}` : ''}.`}</p>}
        {txs.length > 0 && (
          <div data-testid="movement-list">
            {days.map(([day, items]) => (
              <div key={day}>
                <p className="day-head">{limaDayLabel(`${day}T17:00:00Z`)}</p>
                <ul className="tx-list">{items.map((t) => <li key={t.id}><TxRow t={t} /></li>)}</ul>
              </div>
            ))}
          </div>
        )}
        <div className="actions" style={{ marginTop: 16 }}>
          {f.page > 1 && <Link href={`/app/movimientos?${filtersToQuery(f, { page: f.page - 1 })}`} className="button secondary">Anteriores</Link>}
          {from + txs.length < total && <Link href={`/app/movimientos?${filtersToQuery(f, { page: f.page + 1 })}`} className="button secondary">Siguientes</Link>}
        </div>
      </section>
    </main>
  );
}
