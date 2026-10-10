import { redirect } from 'next/navigation';
import { AuthForm } from '../../../components/auth-form';
import { authUser, createSupabaseServerClient } from '../../../lib/supabase/server';
import { PASSWORD_HINT } from '../../../src/web/auth-input';
import { updatePassword } from '../../auth/actions';
import { AuthScreen } from '../../../components/auth-screen';

export const metadata = { title: 'Nueva contraseña · Velsuno' };

export default async function ResetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/login?error=link');
  return (
    <AuthScreen title="Crea una nueva contraseña">
      <AuthForm
        action={updatePassword}
        submit="Guardar contraseña"
        fields={[{ name: 'password', label: 'Nueva contraseña', type: 'password', autoComplete: 'new-password', hint: PASSWORD_HINT }]}
      />
    </AuthScreen>
  );
}
