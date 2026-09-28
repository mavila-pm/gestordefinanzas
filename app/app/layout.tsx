import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient, authUser } from '../../lib/supabase/server';
import { logout } from '../auth/actions';
import { BottomNav, SidebarNav } from '../../components/ui/app-nav';
import { Icon } from '../../components/ui/icon';
import { Logo } from '../../components/ui/logo';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects, but every protected render re-validates the user.
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  const [{ count }, onboarding] = await Promise.all([
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('onboarding_states').select('status').maybeSingle(),
  ]);
  // First access goes to the conversation (ADR-0006); "Ahora no" (skipped) or finished never comes back here.
  if (!onboarding.error && (!onboarding.data || onboarding.data.status === 'active')) redirect('/bienvenida');
  const pending = count ?? 0;
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/app" className="brand" aria-label="Velsuno, ir al resumen"><Logo height={26} /></Link>
        <Link href="/app/movimientos/nuevo" className="button wide"><Icon name="add" />Nuevo movimiento</Link>
        <SidebarNav pending={pending} />
        <div className="foot">
          <small className="muted" title={user.email ?? ''}>{user.email}</small>
          <form action={logout}><button type="submit" className="link" style={{ paddingLeft: 0 }}>Cerrar sesión</button></form>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <Link href="/app" className="brand" aria-label="Velsuno, ir al resumen"><Logo height={22} /></Link>
          <Link href="/app/movimientos/nuevo" className="button icon" aria-label="Registrar movimiento"><Icon name="add" size={22} /></Link>
        </header>
        {children}
      </div>
      <BottomNav pending={pending} />
    </div>
  );
}
