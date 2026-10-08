import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { login } from '../../auth/actions';
import { safeNextPath } from '../../../src/web/auth-input';
import { AuthScreen } from '../../../components/auth-screen';

export const metadata = { title: 'Entrar · Velsuno' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <AuthScreen title="Entra a Velsuno">
      {error === 'link' && (
        <p role="alert" className="notice error" data-testid="link-error">
          <span>Este enlace ya no sirve: venció o ya se usó. <Link href="/signup">Pide uno nuevo</Link> o entra con tu contraseña.</span>
        </p>
      )}
      <AuthForm
        action={login}
        submit="Entrar"
        hidden={{ next: safeNextPath(next) }}
        fields={[
          { name: 'email', label: 'Correo electrónico', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <p className="auth-links"><Link href="/forgot-password">¿Olvidaste tu contraseña?</Link><Link href="/signup">Crear cuenta</Link></p>
      <p className="auth-legal"><Link href="/terminos">Términos y condiciones</Link><span aria-hidden="true"> · </span><Link href="/privacidad">Política de privacidad</Link></p>
    </AuthScreen>
  );
}
