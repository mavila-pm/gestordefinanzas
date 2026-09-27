import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { saveProfileAction } from '../actions';

export default async function Settings() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('profiles').select('display_name').maybeSingle();
  return (
    <main className="stack narrow-md">
      <h1>Ajustes</h1>
      <section className="card">
        <ActionForm action={saveProfileAction} label="Perfil">
          <label className="stack-sm"><span>¿Cómo te llamamos?</span>
            <input name="displayName" maxLength={80} defaultValue={(data?.display_name as string | null) ?? ''} placeholder="Mauro" /></label>
          <p className="muted small">Solo se usa para mensajes como el cierre de mes.</p>
          <button type="submit">Guardar</button>
        </ActionForm>
      </section>
    </main>
  );
}
