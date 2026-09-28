import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { signup } from '../../auth/actions';
import { AuthScreen } from '../../../components/auth-screen';

export const metadata = { title: 'Crear cuenta' };

export default function SignupPage() {
  return (
    <AuthScreen title="Crea tu cuenta" lead="Ordena tus movimientos sin compartir tu clave del banco.">
      <AuthForm
        action={signup}
        submit="Crear cuenta"
        fields={[
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña', type: 'password', autoComplete: 'new-password', hint: 'Mínimo 8 caracteres.', minLength: 8 },
        ]}
      />
      <p className="auth-links"><span className="muted" style={{ display: 'inline-flex', alignItems: 'center' }}>¿Ya tienes cuenta?</span><Link href="/login">Entrar</Link></p>
    </AuthScreen>
  );
}
