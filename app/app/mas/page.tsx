import Link from 'next/link';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { logout } from '../../auth/actions';
import { MORE_ITEMS } from '../../../components/ui/nav-items';
import { Icon } from '../../../components/ui/icon';
import { ThemeControl } from '../../../components/ui/theme-control';

export const metadata = { title: 'Más' };

export default async function More() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <main className="stack narrow-md">
      <h1>Más</h1>
      <ul className="list">
        {MORE_ITEMS.map((i) => (
          <li key={i.href}><Link href={i.href} className="tx-row" style={{ display: 'flex', gap: 12, width: '100%', alignItems: 'center' }}>
            <Icon name={i.icon} /><span style={{ flex: 1 }}>{i.label}</span><Icon name="chevron" size={18} />
          </Link></li>
        ))}
        <li><Link href="/app/importar" className="tx-row" style={{ display: 'flex', gap: 12, width: '100%', alignItems: 'center' }}>
          <Icon name="mail" /><span style={{ flex: 1 }}>Importar mensaje del banco</span><Icon name="chevron" size={18} />
        </Link></li>
      </ul>
      <ThemeControl />
      <div className="stack-sm">
        <small className="muted">{user?.email}</small>
        <form action={logout}><button type="submit" className="secondary wide">Cerrar sesión</button></form>
      </div>
    </main>
  );
}
