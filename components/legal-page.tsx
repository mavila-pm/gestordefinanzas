import Link from 'next/link';
import { Logo } from './ui/logo';

/** Public legal pages (privacy, terms). Content lives in each page; the contact comes from server config. */
export const LEGAL_UPDATED = '7 de octubre de 2026';
export function supportEmail(): string | null {
  const v = process.env.SUPPORT_EMAIL?.trim();
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  const email = supportEmail();
  return (
    <main className="stack narrow-md legal" id="main" style={{ padding: '32px 16px 64px' }}>
      <Link href="/" aria-label="Velsuno, inicio"><Logo height={26} /></Link>
      <h1>{title}</h1>
      <p className="muted">Última actualización: {LEGAL_UPDATED}.</p>
      {children}
      <h2>Contacto</h2>
      <p>{email ? <>Escríbenos a <a href={`mailto:${email}`}>{email}</a>.</> : 'El correo de contacto se publicará antes del lanzamiento.'}</p>
      <p className="auth-links"><Link href="/privacidad">Privacidad</Link><Link href="/terminos">Términos</Link><Link href="/signup">Crear cuenta</Link></p>
    </main>
  );
}
