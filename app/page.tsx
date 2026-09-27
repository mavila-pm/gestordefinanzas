import Link from 'next/link';

export default function Home() {
  return (
    <main className="narrow stack">
      <h1>Gestor Financiero</h1>
      <p>Tus finanzas se registran prácticamente solas y la aplicación te explica qué está pasando con tu dinero.</p>
      <p><Link href="/signup">Crear cuenta</Link> · <Link href="/login">Iniciar sesión</Link></p>
    </main>
  );
}
