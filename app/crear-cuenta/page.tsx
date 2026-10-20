import { redirect } from 'next/navigation';
import { registrationStep } from '../../lib/registration';
import { authUser, createSupabaseServerClient } from '../../lib/supabase/server';
import { registrationLanding } from '../../src/web/auth-input';

/**
 * Where the email link lands: continue at the step this account is on. An account that already existed goes to the
 * app with a one-time "Ya tenías una cuenta" notice; the app layout still sends an unfinished first conversation to
 * /bienvenida, and a skipped one ("Ahora no") is not started again.
 */
export default async function RegistrationRouter() {
  const supabase = await createSupabaseServerClient();
  if (!(await authUser(supabase))) redirect('/signup');
  redirect(registrationLanding(await registrationStep(supabase)));
}
