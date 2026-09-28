import Link from 'next/link';
import { Logo } from './ui/logo';

/** Calm frame for access screens: logo, one heading, the form. No marketing around it. */
export function AuthScreen({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-panel">
        <Link href="/" className="brand" aria-label="Velsuno, inicio"><Logo height={26} /></Link>
        <div className="page-head">
          <h1>{title}</h1>
          {lead && <p>{lead}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}
