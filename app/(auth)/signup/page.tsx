import Link from 'next/link';
import { AuthScreen } from '../../../components/auth-screen';
import { SignupForm } from '../../../components/signup-form';

export const metadata = { title: 'Crear cuenta · Velsuno' };

/** Registration starts with the email only; password and profile come after the link (app/crear-cuenta). */
export default function SignupPage() {
  return (
    <AuthScreen title="Crea tu cuenta" lead="Organiza tus gastos y entiende mejor tus finanzas.">
      <SignupForm />
      <p className="auth-links"><span className="muted" style={{ display: 'inline-flex', alignItems: 'center' }}>¿Ya tienes cuenta?</span><Link href="/login">Entrar</Link></p>
    </AuthScreen>
  );
}
