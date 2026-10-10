import { redirect } from 'next/navigation';
import { AuthScreen } from '../../../components/auth-screen';
import { ProfileForm } from '../../../components/profile-form';
import { registrationStep } from '../../../lib/registration';
import { authUser, createSupabaseServerClient } from '../../../lib/supabase/server';
import { limaToday } from '../../../src/domain/dates';

export const metadata = { title: 'Cuéntanos sobre ti · Velsuno' };

export default async function ProfileStepPage() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/signup');
  const step = await registrationStep(supabase);
  if (step !== 'profile') redirect(step === 'password' ? '/crear-cuenta/contrasena' : '/bienvenida');
  const today = limaToday();
  const maxBirth = `${Number(today.slice(0, 4)) - 18}${today.slice(4)}`;
  return (
    <AuthScreen title="Cuéntanos sobre ti" step="Paso 2 de 2">
      <ProfileForm email={user.email ?? ''} maxBirthDate={maxBirth} />
    </AuthScreen>
  );
}
