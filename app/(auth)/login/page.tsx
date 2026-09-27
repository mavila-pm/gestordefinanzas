import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { login } from '../../auth/actions';
import { safeNextPath } from '../../../src/web/auth-input';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="narrow stack">
      <h1>Iniciar sesión</h1>
      {error === 'link' && <p role="alert" className="error">El enlace no es válido o expiró.</p>}
      <AuthForm
        action={login}
        submit="Entrar"
        hidden={{ next: safeNextPath(next) }}
        fields={[
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <p><Link href="/forgot-password">¿Olvidaste tu contraseña?</Link> · <Link href="/signup">Crear cuenta</Link></p>
    </main>
  );
}
