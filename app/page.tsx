import { redirect } from 'next/navigation';
import { authUser, createSupabaseServerClient } from '../lib/supabase/server';

/** No welcome screen: `/` sends a signed-in person to the app and everyone else to /login (the one access screen). */
export default async function Home() {
  const user = await authUser(await createSupabaseServerClient());
  redirect(user ? '/app' : '/login');
}
