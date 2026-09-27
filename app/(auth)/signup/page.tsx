import Link from 'next/link';
import { AuthForm } from '../../../components/auth-form';
import { signup } from '../../auth/actions';

export default function SignupPage() {
  return (
    <main className="narrow stack">
      <h1>Crear cuenta</h1>
      <AuthForm
        action={signup}
        submit="Crear cuenta"
        fields={[
          { name: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Contraseña (mínimo 8 caracteres)', type: 'password', autoComplete: 'new-password' },
        ]}
      />
      <p>¿Ya tienes cuenta? <Link href="/login">Inicia sesión</Link></p>
    </main>
  );
}
