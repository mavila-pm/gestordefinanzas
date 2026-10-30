import Image from 'next/image';
import { Logo } from './ui/logo';
import authPhoto from '../public/auth/velsuno-acceso.webp';
import { AuthOrb } from './ui/auth-orb';

/**
 * Access screens (signup, login, recovery, registration steps).
 * Mobile/tablet: brand line, then the form (no photo). Desktop (≥ 1024 px): the photo fills the side
 * panel with a short line over a dark gradient; the slogan stays under the logo at every width. Decorative only (alt=""), optimized and lazy: the form renders first.
 */
export function AuthScreen({ title, lead, step, variant, children }: { title: string; lead?: string; step?: string; variant?: 'login' | 'signup'; children: React.ReactNode }) {
  if (variant === 'login') return <LoginScreen title={title} lead={lead}>{children}</LoginScreen>;
  // "Crea tu cuenta" (mockups 2026-10-30): the same screen, orb and motion as the login; its lead is the same on phone.
  if (variant === 'signup') return <LoginScreen title={title} lead={lead} narrowLead={lead} className="auth-signup">{children}</LoginScreen>;
  return (
    <main className="auth">
      <aside className="auth-art" aria-hidden="true">
        <Image src={authPhoto} alt="" fill sizes="(min-width: 1024px) 50vw, 1px" placeholder="blur" quality={70} className="auth-art-photo" />
        <div className="auth-art-shade" />
        <div className="auth-art-copy">
          <p className="auth-sub">Organiza tus gastos y entiende mejor tus finanzas.</p>
        </div>
      </aside>
      <div className="auth-panel">
        <div className="brand"><Logo height={26} /></div>
        <p className="auth-tagline">Tu dinero, más claro.</p>
        <div className="page-head">
          {step && <p className="auth-step">{step}</p>}
          <h1>{title}</h1>
          {lead && <p>{lead}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * Login variant (mockups 2026-10-27): always dark inside the screen (data-theme on the container only; the rest
 * of the app keeps the person's theme), continuous background, glass orb. Desktop ≥ 1024 px: two columns
 * (orb + slogan | form); mobile/tablet: one column (logo, small orb, title, form) with natural vertical scroll.
 */
function LoginScreen({ title, lead, narrowLead = 'Tu dinero, más claro.', className, children }: {
  title: string; lead?: string; narrowLead?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <main className={className ? `auth-login ${className}` : 'auth-login'} data-theme="dark">
      <div className="auth-login-art">
        <div className="brand"><Logo height={30} /></div>
        <AuthOrb className="auth-login-orb" />
        <div className="auth-login-claim" aria-hidden="true">
          <p className="auth-login-slogan">Tu dinero,<br />más claro.</p>
          <p className="auth-login-sub">Organiza tus gastos y entiende mejor tus finanzas.</p>
        </div>
      </div>
      <div className="auth-login-panel">
        <div className="auth-login-head">
          <h1>{title}</h1>
          <p className="auth-login-lead auth-login-lead-wide">{lead}</p>
          <p className="auth-login-lead auth-login-lead-narrow">{narrowLead}</p>
        </div>
        {children}
      </div>
    </main>
  );
}
