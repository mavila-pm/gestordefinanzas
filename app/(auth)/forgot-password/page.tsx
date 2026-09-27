import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { requestPasswordReset } from '../../auth/actions';

export default function ForgotPasswordPage() {
  return (
    <main className="narrow stack">
      <h1>Recuperar contraseña</h1>
      <AuthForm
        action={requestPasswordReset}
        submit="Enviar enlace"
        fields={[{ name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' }]}
      />
      <p><Link href="/login">Volver a iniciar sesión</Link></p>
    </main>
  );
}
