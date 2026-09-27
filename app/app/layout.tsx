import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { logout } from '../auth/actions';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects, but every protected render re-validates the user.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { count } = await supabase.from('transactions').select('id', { count: 'exact', head: true })
    .in('status', ['review_required', 'possible_duplicate']);
  return (
    <>
      <header className="topbar">
        <strong>Gestor Financiero</strong>
        <nav className="nav">
          <Link href="/app">Resumen</Link>
          <Link href="/app/movimientos?month=all">Movimientos</Link>
          <Link href="/app/revisar">Por revisar{count ? <span className="badge" data-testid="review-count">{count}</span> : null}</Link>
          <Link href="/app/analisis">Análisis</Link>
          <Link href="/app/movimientos/nuevo">Nuevo movimiento</Link>
          <Link href="/app/importar">Importar</Link>
          <Link href="/app/tarjetas">Tarjetas y cuentas</Link>
          <Link href="/app/reglas">Reglas</Link>
          <Link href="/app/conexiones">Conexiones</Link>
          <Link href="/app/ajustes">Ajustes</Link>
        </nav>
        <span className="muted">{user.email}</span>
        <form action={logout}><button type="submit" className="link">Cerrar sesión</button></form>
      </header>
      {children}
    </>
  );
}
