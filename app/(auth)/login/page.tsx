import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { login } from '../../auth/actions';
import { safeNextPath } from '../../../src/web/auth-input';
import { AuthScreen } from '../../../components/auth-screen';

export const metadata = { title: 'Entrar' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <AuthScreen title="Entra a tu cuenta" lead="Tu dinero, más claro.">
      {error === 'link' && <p role="alert" className="notice error">El enlace no es válido o expiró. Pide uno nuevo.</p>}
      <AuthForm
        action={login}
        submit="Entrar"
        hidden={{ next: safeNextPath(next) }}
        fields={[
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <p className="auth-links"><Link href="/forgot-password">Olvidé mi contraseña</Link><Link href="/signup">Crear cuenta</Link></p>
    </AuthScreen>
  );
}
