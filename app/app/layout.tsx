import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { logout } from '../auth/actions';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects, but every protected render re-validates the user.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return (
    <>
      <header className="topbar">
        <strong>Gestor Financiero</strong>
        <span className="muted">{user.email}</span>
        <form action={logout}><button type="submit" className="link">Cerrar sesión</button></form>
      </header>
      {children}
    </>
  );
}
