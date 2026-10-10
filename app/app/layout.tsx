import Link from 'next/link';
import { redirect } from 'next/navigation';
import { registrationStep } from '../../lib/registration';
import { createSupabaseServerClient, authUser } from '../../lib/supabase/server';
import { BottomNav, SidebarNav } from '../../components/ui/app-nav';
import { Icon } from '../../components/ui/icon';
import { Logo } from '../../components/ui/logo';
import { VelsBubble } from '../../components/vels';
import { Avatar } from '../../components/settings';
import { loadProfile } from '../../lib/queries';
import { preferredName } from '../../src/domain/profile';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects, but every protected render re-validates the user.
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  const [{ count }, onboarding, step, profile] = await Promise.all([
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('onboarding_states').select('status').maybeSingle(),
    registrationStep(supabase),
    loadProfile(supabase),
  ]);
  const name = preferredName(profile);
  // A new account finishes registration (password, profile, consents) before anything else.
  if (step !== 'done') redirect('/crear-cuenta');
  // First access goes to the conversation (ADR-0006); "Ahora no" (skipped) or finished never comes back here.
  if (!onboarding.error && (!onboarding.data || onboarding.data.status === 'active')) redirect('/bienvenida');
  const pending = count ?? 0;
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/app" className="brand" aria-label="Velsuno, ir al resumen"><Logo height={26} /></Link>
        <Link href="/app/movimientos/nuevo" className="button wide"><Icon name="add" />Nuevo movimiento</Link>
        <SidebarNav pending={pending} />
        <Link href="/app/ajustes" className="foot account-entry" data-testid="account-entry" aria-label="Ajustes de tu cuenta">
          <Avatar name={name} size={36} />
          <span className="account-text"><strong>{name ?? 'Tu cuenta'}</strong><small className="muted">Ajustes</small></span>
        </Link>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <Link href="/app" className="brand" aria-label="Velsuno, ir al resumen"><Logo height={22} /></Link>
          <span className="actions" style={{ gap: 4 }}>
            <Link href="/app/movimientos/nuevo" className="button icon" aria-label="Registrar movimiento"><Icon name="add" size={22} /></Link>
            <Link href="/app/ajustes" className="topbar-avatar" aria-label="Ajustes de tu cuenta" data-testid="account-entry-mobile"><Avatar name={name} size={32} /></Link>
          </span>
        </header>
        {children}
      </div>
      <BottomNav pending={pending} />
      <VelsBubble />
    </div>
  );
}
