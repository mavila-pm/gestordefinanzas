import { redirect } from 'next/navigation';

/** "Tu plan" now lives in Ajustes → Plan y uso (old links keep working). */
export default function Account() {
  redirect('/app/ajustes/plan');
}
