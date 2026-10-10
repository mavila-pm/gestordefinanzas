import Link from 'next/link';
import { PRIMARY, REVIEW, SETUP } from '../../../components/ui/nav-items';
import { Icon } from '../../../components/ui/icon';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { resumeOnboardingAction } from '../cuenta/demo-actions';

export const metadata = { title: 'Más' };

function Group({ title, items }: { title: string; items: typeof PRIMARY }) {
  return (
    <section className="group" aria-label={title}>
      <h2 className="group-title">{title}</h2>
      <div className="rows">
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="setting link-row">
            <span className="actions" style={{ gap: 12 }}><Icon name={i.icon} /><strong style={{ fontWeight: 500 }}>{i.label}</strong></span>
            <Icon name="chevron" size={18} />
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Mobile home for everything that is not a daily task. Two groups, not a flat list of ten equal rows. */
export default async function More() {
  const supabase = await createSupabaseServerClient();
  const [{ data: onboarding }, { count }] = await Promise.all([supabase.from('onboarding_states').select('status').maybeSingle(),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate'])]);
  const pending = count ?? 0;
  return (
    <main className="stack narrow-md">
      <h1>Más</h1>
      {onboarding?.status === 'skipped' && (
        <form action={resumeOnboardingAction}>
          <button type="submit" className="quiet wide"><Icon name="chat" size={18} />Terminar de configurar conversando</button>
        </form>
      )}
      <Link href="/app/importar" className="button quiet wide"><Icon name="mail" size={18} />Pegar un mensaje del banco</Link>
      {pending > 0 && <Link href="/app/revisar" className="notice warning review-alert"><strong>{pending} por revisar</strong><Icon name="chevron" size={18} /></Link>}
      <Group title="Tu dinero" items={[PRIMARY[3]!, PRIMARY[4]!, ...(pending > 0 ? [REVIEW] : [])]} />
      <Group title="Configuración" items={SETUP} />
    </main>
  );
}
