import { redirect } from 'next/navigation';
import { AuthScreen } from '../../../components/auth-screen';
import { NewPasswordForm } from '../../../components/new-password-form';
import { registrationStep } from '../../../lib/registration';
import { authUser, createSupabaseServerClient } from '../../../lib/supabase/server';

export const metadata = { title: 'Crea tu contraseña · Velsuno' };

export default async function CreatePasswordPage() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/signup');
  const step = await registrationStep(supabase);
  if (step !== 'password') redirect(step === 'profile' ? '/crear-cuenta/perfil' : '/bienvenida');
  return (
    <AuthScreen title="Crea tu contraseña" step="Paso 1 de 2" lead={user.email ? `Para ${user.email}` : undefined}>
      <NewPasswordForm />
    </AuthScreen>
  );
}
