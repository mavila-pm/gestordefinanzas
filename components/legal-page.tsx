import Link from 'next/link';
import { LEGAL_UPDATED } from '../src/web/legal';
import { Logo } from './ui/logo';

/** Public legal pages (Terms, Privacy): index, version, cross-links and a way back to signup. Text lives in each page. */
export function supportEmail(): string | null {
  const v = process.env.SUPPORT_EMAIL?.trim();
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export interface LegalSection { id: string; title: string; body: React.ReactNode }

export function LegalPage({ title, version, intro, sections }: { title: string; version: string; intro: React.ReactNode; sections: LegalSection[] }) {
  const email = supportEmail();
  return (
    <main className="legal" id="main">
      <header className="legal-head">
        <Link href="/" aria-label="Velsuno, inicio"><Logo height={24} /></Link>
        <Link href="/signup" className="link">Volver a crear cuenta</Link>
      </header>
      <h1>{title}</h1>
      <p className="muted legal-meta">Versión {version} · Última actualización: {LEGAL_UPDATED}</p>
      <div className="legal-intro">{intro}</div>
      <nav aria-label="Contenido" className="legal-toc">
        <ol>{sections.map((s, i) => <li key={s.id}><a href={`#${s.id}`}>{i + 1}. {s.title}</a></li>)}</ol>
      </nav>
      {sections.map((s, i) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
          <h2 id={`${s.id}-h`}>{i + 1}. {s.title}</h2>
          {s.body}
        </section>
      ))}
      <section aria-labelledby="contact-h">
        <h2 id="contact-h">Contacto</h2>
        <p>{email ? <>Escríbenos a <a href={`mailto:${email}`}>{email}</a>.</> : 'Correo de contacto: [CORREO DE CONTACTO — por completar].'}</p>
      </section>
      <p className="auth-links legal-foot"><Link href="/terminos">Términos</Link><Link href="/privacidad">Política de Privacidad</Link><Link href="/signup">Crear cuenta</Link><Link href="/login">Entrar</Link></p>
    </main>
  );
}
