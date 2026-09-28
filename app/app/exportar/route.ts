import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { transactionsToCsv } from '../../../src/web/export-csv';
import { KIND_TYPES, parseMovementFilters, SOURCE_VALUES, STATUS_VALUES } from '../../../src/web/movement-filters';

const MAX_ROWS = 5000;

/** CSV export of the signed-in user's movements (RLS-scoped), with the same filters as the list. */
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return new NextResponse('No autenticado', { status: 401 });
  const f = parseMovementFilters(Object.fromEntries(request.nextUrl.searchParams), limaMonth());
  const select = f.source === 'all' ? TRANSACTION_SELECT : `${TRANSACTION_SELECT},src_filter:transaction_sources!inner(channel)`;
  let q = supabase.from('transactions').select(select);
  if (f.month !== 'all') { const r = limaMonthRange(f.month)!; q = q.gte('occurred_at', r.from).lt('occurred_at', r.to); }
  if (f.status !== 'all') q = q.in('status', STATUS_VALUES[f.status]);
  if (f.kind !== 'all') q = q.in('type', KIND_TYPES[f.kind]);
  if (f.source !== 'all') q = q.in('src_filter.channel', SOURCE_VALUES[f.source]);
  if (f.categoryId) q = q.eq('category_id', f.categoryId);
  if (f.currency !== 'all') q = q.eq('currency', f.currency);
  if (f.q) q = q.ilike('merchant_raw', `%${f.q}%`);
  const { data, error } = await q.order('occurred_at', { ascending: true }).limit(MAX_ROWS);
  if (error) return new NextResponse('No se pudo exportar', { status: 500 });
  const csv = transactionsToCsv((data as unknown as TransactionRow[]).map(rowToTransaction));
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="movimientos-${f.month}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
