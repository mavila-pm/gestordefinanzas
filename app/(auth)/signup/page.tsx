import Link from 'next/link';
import { AuthScreen } from '../../../components/auth-screen';
import { SignupForm } from '../../../components/signup-form';

export const metadata = { title: 'Crear cuenta · Velsuno' };

/**
 * Registration starts with the email only; password and profile come after the link (app/crear-cuenta). The same
 * form is the "enter with a link" way in (?modo=enlace, offered by a locked login): a registered address gets a
 * sign-in link, a new one starts its account. The answer is identical either way (no enumeration).
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ modo?: string }> }) {
  const { modo } = await searchParams;
  const viaLink = modo === 'enlace';
  return (
    <AuthScreen title={viaLink ? 'Entra con un enlace' : 'Crea tu cuenta'}
      lead={viaLink ? 'Te enviamos un enlace a tu correo para entrar sin contraseña.' : 'Organiza tus gastos y entiende mejor tus finanzas.'}>
      <SignupForm />
      <p className="auth-links"><span className="muted" style={{ display: 'inline-flex', alignItems: 'center' }}>¿Ya tienes cuenta?</span><Link href="/login">Entrar</Link></p>
    </AuthScreen>
  );
}
