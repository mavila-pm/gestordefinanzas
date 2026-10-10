import Link from 'next/link';
import { formatMoney } from '../src/domain/money';
import type { Transaction } from '../src/domain/types';
import { SOURCE_LABEL, STATUS_LABEL } from '../src/web/labels';
import { TYPE_LABEL } from '../src/web/transaction-input';

type Row = Pick<Transaction, 'id' | 'type' | 'direction' | 'amountMinor' | 'currency' | 'merchantRaw' | 'category' | 'status' | 'institution' | 'cardLast4' | 'sources'>
  & { allocations?: readonly unknown[] };

/** One movement: what, context in one line, signed amount. The whole row opens the detail. */
export function TxRow({ t, when }: { t: Row; when?: string }) {
  const status = STATUS_LABEL[t.status];
  const meta = [
    when,
    t.allocations?.length ? 'Dividido' : t.category ?? TYPE_LABEL[t.type],
    t.institution && t.cardLast4 ? `${t.institution} ····${t.cardLast4}` : t.institution,
    SOURCE_LABEL[t.sources[0]?.channel ?? 'manual'],
  ].filter(Boolean).join(' · ');
  const sign = t.direction === 'inflow' ? '+' : t.direction === 'outflow' ? '−' : '';
  return (
    <Link href={`/app/movimientos/${t.id}`} className="tx-row">
      <span className="name">{t.merchantRaw ?? TYPE_LABEL[t.type]}</span>
      <span className={`amount${t.direction === 'inflow' ? ' in' : ''}`}>{sign}{formatMoney(t)}</span>
      <span className="meta">{status && <span className={`tag${t.status === 'ignored' ? '' : ' review'}`} style={{ marginRight: 8 }}>{status}</span>}{meta}</span>
    </Link>
  );
}
