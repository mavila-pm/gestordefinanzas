import { redirect } from 'next/navigation';
import { AuthForm } from '../../../components/auth-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { updatePassword } from '../../auth/actions';

export default async function ResetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?error=link');
  return (
    <main className="narrow stack">
      <h1>Nueva contraseña</h1>
      <AuthForm
        action={updatePassword}
        submit="Guardar contraseña"
        fields={[
          { name: 'password', label: 'Nueva contraseña (mínimo 8 caracteres)', type: 'password', autoComplete: 'new-password' },
          { name: 'confirm', label: 'Repite la contraseña', type: 'password', autoComplete: 'new-password' },
        ]}
      />
    </main>
  );
}
