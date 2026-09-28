import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { requestPasswordReset } from '../../auth/actions';
import { AuthScreen } from '../../../components/auth-screen';

export default function ForgotPasswordPage() {
  return (
    <AuthScreen title="Recuperar contraseña" lead="Te enviaremos un enlace para crear una nueva.">
      <AuthForm
        action={requestPasswordReset}
        submit="Enviar enlace"
        fields={[{ name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' }]}
      />
      <p className="auth-links"><Link href="/login">Volver a entrar</Link></p>
    </AuthScreen>
  );
}
