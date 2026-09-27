import Link from 'next/link';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { LINKED_SELECT, loadCatalog, toLinked } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import {
  filtersToQuery, KIND_TYPES, PAGE_SIZE, parseMovementFilters, SOURCE_VALUES, STATUS_VALUES,
} from '../../../src/web/movement-filters';
import { formatLimaDateTime, TYPE_LABEL } from '../../../src/web/transaction-input';

const SOURCE_LABEL: Record<string, string> = { email: 'Automático · Email', sms: 'Automático · SMS', import: 'Importado', manual: 'Manual' };
const STATUS_LABEL: Record<string, string> = { review_required: 'Por revisar', possible_duplicate: 'Posible duplicado', ignored: 'Ignorado' };

export default async function Movements({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseMovementFilters(await searchParams, limaMonth());
  const supabase = await createSupabaseServerClient();
  const catalog = await loadCatalog(supabase);

  // Every filter is applied server-side under RLS; values come from fixed whitelists (movement-filters.ts).
  const select = f.source === 'all' ? LINKED_SELECT : `${LINKED_SELECT},src_filter:transaction_sources!inner(channel)`;
  let q = supabase.from('transactions').select(select, { count: 'exact' });
  if (f.month !== 'all') { const r = limaMonthRange(f.month)!; q = q.gte('occurred_at', r.from).lt('occurred_at', r.to); }
  if (f.status !== 'all') q = q.in('status', STATUS_VALUES[f.status]);
  if (f.kind !== 'all') q = q.in('type', KIND_TYPES[f.kind]);
  if (f.source !== 'all') q = q.in('src_filter.channel', SOURCE_VALUES[f.source]);
  if (f.categoryId) q = q.eq('category_id', f.categoryId);
  if (f.currency !== 'all') q = q.eq('currency', f.currency);
  if (f.q) q = q.ilike('merchant_raw', `%${f.q}%`);
  const from = (f.page - 1) * PAGE_SIZE;
  const { data, count, error } = await q.order('occurred_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
  const txs = error ? [] : (data as never[]).map(toLinked);
  const total = count ?? 0;

  const opt = (value: string, label: string) => <option key={value} value={value}>{label}</option>;
  return (
    <main className="stack">
      <div className="row"><h1>Movimientos</h1><a href={`/app/exportar?${filtersToQuery(f, { page: 1 })}`} data-testid="export-link">Exportar CSV</a></div>
      <form className="card filters" method="get" aria-label="Filtros">
        <label className="stack-sm"><span>Mes</span><input name="month" type="month" defaultValue={f.month === 'all' ? '' : f.month} /></label>
        <label className="stack-sm"><span>Estado</span><select name="status" defaultValue={f.status}>
          {opt('all', 'Todos')}{opt('confirmed', 'Confirmados')}{opt('pending', 'Por revisar')}{opt('ignored', 'Ignorados')}</select></label>
        <label className="stack-sm"><span>Tipo</span><select name="kind" defaultValue={f.kind}>
          {opt('all', 'Todos')}{opt('expense', 'Gastos')}{opt('income', 'Ingresos')}{opt('internal', 'Pagos de tarjeta y transferencias propias')}
          {opt('withdrawal', 'Retiros de efectivo')}{opt('refund', 'Devoluciones y reversos')}{opt('unknown', 'Sin determinar')}</select></label>
        <label className="stack-sm"><span>Origen</span><select name="source" defaultValue={f.source}>
          {opt('all', 'Todos')}{opt('auto', 'Automático')}{opt('import', 'Importado')}{opt('manual', 'Manual')}</select></label>
        <label className="stack-sm"><span>Categoría</span><select name="category" defaultValue={f.categoryId ?? ''}>
          <option value="">Todas</option>{catalog.categories.map((c) => opt(c.id, c.name))}</select></label>
        <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue={f.currency}>
          {opt('all', 'Todas')}{opt('PEN', 'Soles')}{opt('USD', 'Dólares')}</select></label>
        <label className="stack-sm grow"><span>Buscar comercio o descripción</span><input name="q" defaultValue={f.q} maxLength={60} /></label>
        <div className="actions"><button type="submit">Filtrar</button><Link href={`/app/movimientos?month=all`}>Ver todo</Link></div>
      </form>

      <section className="card stack-sm">
        <p className="muted" data-testid="movement-count">{total} movimiento(s){f.month !== 'all' ? ` en ${f.month}` : ''}</p>
        {error && <p role="alert" className="error">No se pudieron cargar los movimientos.</p>}
        {txs.length > 0 && (
          <ul className="list" data-testid="movement-list">
            {txs.map((t) => (
              <li key={t.id}>
                <span>
                  <Link href={`/app/movimientos/${t.id}`}><strong>{t.merchantRaw ?? TYPE_LABEL[t.type]}</strong></Link><br />
                  <small className="muted">{[formatLimaDateTime(t.occurredAt), TYPE_LABEL[t.type], t.category, SOURCE_LABEL[t.sources[0]?.channel ?? 'manual'], STATUS_LABEL[t.status]].filter(Boolean).join(' · ')}</small>
                </span>
                <span className="amount">{t.direction === 'inflow' ? '+' : t.direction === 'outflow' ? '−' : ''}{formatMoney(t)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          {f.page > 1 && <Link href={`/app/movimientos?${filtersToQuery(f, { page: f.page - 1 })}`}>← Anteriores</Link>}
          {from + txs.length < total && <Link href={`/app/movimientos?${filtersToQuery(f, { page: f.page + 1 })}`}>Siguientes →</Link>}
        </div>
      </section>
    </main>
  );
}
