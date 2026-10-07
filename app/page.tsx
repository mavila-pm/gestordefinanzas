import Link from 'next/link';
import { Logo } from '../components/ui/logo';

export default async function Home({ searchParams }: { searchParams: Promise<{ cuenta?: string }> }) {
  const deleted = (await searchParams).cuenta === 'eliminada';
  return (
    <main className="auth">
      <div className="auth-panel">
        <Logo height={30} />
        {deleted && <p className="notice" role="status" data-testid="account-deleted">Eliminamos tu cuenta y todos tus datos.</p>}
        <div className="page-head">
          <h1 style={{ fontSize: 36, lineHeight: '44px' }}>Tu dinero, más claro.</h1>
          <p>Tus movimientos, ordenados y explicados. Lo dudoso te lo preguntamos; nada se confirma solo. Nunca te pediremos la clave de tu banco.</p>
        </div>
        <div className="stack-sm" style={{ gap: 12 }}>
          <Link href="/signup" className="button wide">Crear cuenta</Link>
          <Link href="/login" className="button secondary wide">Entrar</Link>
        </div>
        <p className="auth-links"><Link href="/privacidad">Privacidad</Link><Link href="/terminos">Términos</Link></p>
      </div>
    </main>
  );
}
