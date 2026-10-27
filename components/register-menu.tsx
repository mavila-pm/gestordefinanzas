import Link from 'next/link';
import { Icon } from './ui/icon';
import { Sheet } from './ui/sheet';

const KINDS = {
  movement: { label: 'Registrar movimiento', vels: '/app/preguntar', manual: '/app/movimientos/nuevo' },
  income: { label: 'Registrar ingreso', vels: '/app/preguntar?tema=ingreso', manual: '/app/movimientos/nuevo?tipo=income' },
  expense: { label: 'Registrar gasto', vels: '/app/preguntar?tema=gasto', manual: '/app/movimientos/nuevo?tipo=expense' },
} as const;

/** "Registrar …": tell Vels in your own words, or fill the form. From Ingresos / Gastos it already knows which. */
export function RegisterMenu({ className = '', kind = 'movement' }: { className?: string; kind?: keyof typeof KINDS }) {
  const k = KINDS[kind];
  return (
    <Sheet label={<><Icon name="add" size={18} />{k.label}</>} triggerClassName={className} title={k.label} testId={kind === 'movement' ? 'register-sheet' : `register-${kind}`}>
      <div className="sheet-body stack-sm">
        <Link href={k.vels} className="button wide"><Icon name="chat" size={18} />Contárselo a Vels</Link>
        <Link href={k.manual} className="button secondary wide"><Icon name="add" size={18} />Registrar manualmente</Link>
      </div>
    </Sheet>
  );
}
