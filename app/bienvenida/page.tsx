import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Chat } from '../../components/chat';
import { Logo } from '../../components/ui/logo';
import { aiAvailable } from '../../src/ai/config';
import { onboardingConversation, onboardingResume, startOnboarding } from '../../lib/onboarding';
import { registrationStep } from '../../lib/registration';
import { createSupabaseServerClient, authUser } from '../../lib/supabase/server';
import { leaveOnboarding, onboardingAction } from './actions';

export const metadata: Metadata = { title: 'Bienvenida · Velsuno' };

/** First access (ADR-0006): a full-screen conversation instead of an empty dashboard or a long form. */
export default async function Bienvenida() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  if ((await registrationStep(supabase)) !== 'done') redirect('/crear-cuenta');
  const state = await startOnboarding(supabase, user.id);
  if (state.status === 'completed') redirect('/app');
  if (state.status === 'skipped') await onboardingResume(supabase, user.id);
  const messages = await onboardingConversation(supabase);
  return (
    <div className="onboarding">
      <header className="onboarding-top">
        <span className="brand" aria-label="Velsuno"><Logo height={22} /></span>
        <form action={leaveOnboarding}><button type="submit" className="link">Ahora no</button></form>
      </header>
      <main className="onboarding-body" id="main">
        <h1 className="sr-only">Configura Velsuno conversando</h1>
        <Chat initial={messages} send={onboardingAction} camera={aiAvailable()} label="Conversación de bienvenida"
          placeholder="Escribe como te salga…" />
      </main>
    </div>
  );
}
