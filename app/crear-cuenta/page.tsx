import { redirect } from 'next/navigation';
import { registrationStep } from '../../lib/registration';
import { authUser, createSupabaseServerClient } from '../../lib/supabase/server';

/** Where the email link lands: continue at the step this account is on (an existing account goes to the app). */
export default async function RegistrationRouter() {
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/signup');
  const step = await registrationStep(supabase);
  redirect(step === 'password' ? '/crear-cuenta/contrasena' : step === 'profile' ? '/crear-cuenta/perfil' : '/bienvenida');
}
