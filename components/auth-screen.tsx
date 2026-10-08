import Image from 'next/image';
import { Logo } from './ui/logo';
import authPhoto from '../public/auth/velsuno-acceso.webp';

/**
 * Access screens (signup, login, recovery, registration steps).
 * Mobile/tablet: brand line, then the form (no photo). Desktop (≥ 1024 px): the photo fills the side
 * panel with the slogan over a dark gradient. Decorative only (alt=""), optimized and lazy: the form renders first.
 */
export function AuthScreen({ title, lead, step, children }: { title: string; lead?: string; step?: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <aside className="auth-art" aria-hidden="true">
        <Image src={authPhoto} alt="" fill sizes="(min-width: 1024px) 50vw, 1px" placeholder="blur" quality={70} className="auth-art-photo" />
        <div className="auth-art-shade" />
        <div className="auth-art-copy">
          <p className="auth-slogan">Tu dinero, más claro.</p>
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
