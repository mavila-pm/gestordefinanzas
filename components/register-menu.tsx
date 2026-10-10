import Link from 'next/link';
import { Icon } from './ui/icon';
import { Sheet } from './ui/sheet';

/** "+ Registrar movimiento": tell Vels in your own words, or fill the form. */
export function RegisterMenu({ className = '' }: { className?: string }) {
  return (
    <Sheet label={<><Icon name="add" size={18} />Registrar movimiento</>} triggerClassName={className} title="Registrar movimiento" testId="register-sheet">
      <div className="sheet-body stack-sm">
        <Link href="/app/preguntar" className="button wide"><Icon name="chat" size={18} />Contárselo a Vels</Link>
        <Link href="/app/movimientos/nuevo" className="button secondary wide"><Icon name="add" size={18} />Registrar manualmente</Link>
      </div>
    </Sheet>
  );
}
