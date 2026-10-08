import Link from 'next/link';
import { Logo } from './ui/logo';

/**
 * Access screens (signup, login, recovery, registration steps). Mobile: the form first, brand line on top.
 * Desktop (≥ 1024 px): a calm brand panel beside the form. The panel is pure CSS (no media download); a licensed
 * background video can be added in `.auth-art` later without touching the form (docs/runbooks/auth-email.md).
 */
export function AuthScreen({ title, lead, step, children }: { title: string; lead?: string; step?: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <aside className="auth-art" aria-hidden="true">
        <div className="auth-art-glow" />
        <div className="auth-art-copy">
          <Logo height={30} />
          <p className="auth-slogan">Tu dinero, más claro.</p>
          <p className="auth-sub">Organiza tus gastos y entiende mejor tus finanzas.</p>
        </div>
      </aside>
      <div className="auth-panel">
        <Link href="/" className="brand" aria-label="Velsuno, inicio"><Logo height={26} /></Link>
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
