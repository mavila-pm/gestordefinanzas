import { redirect } from 'next/navigation';
import { AuthForm } from '../../../components/auth-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { updatePassword } from '../../auth/actions';
import { AuthScreen } from '../../../components/auth-screen';

export default async function ResetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?error=link');
  return (
    <AuthScreen title="Nueva contraseña">
      <AuthForm
        action={updatePassword}
        submit="Guardar contraseña"
        fields={[
          { name: 'password', label: 'Nueva contraseña', type: 'password', autoComplete: 'new-password', hint: 'Mínimo 8 caracteres.', minLength: 8 },
          { name: 'confirm', label: 'Repite la contraseña', type: 'password', autoComplete: 'new-password' },
        ]}
      />
    </AuthScreen>
  );
}
