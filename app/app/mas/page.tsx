import Link from 'next/link';
import { GROUPS, MOBILE, MONEY_SETUP, REVIEW, type Item } from '../../../components/ui/nav-items';
import { Icon } from '../../../components/ui/icon';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { resumeOnboardingAction } from '../ajustes/demo-actions';

export const metadata = { title: 'Más' };

function Group({ title, items }: { title: string; items: Item[] }) {
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

/** Mobile home for everything not in the bottom bar, in the same groups as the desktop sidebar. */
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
      {GROUPS.map((g) => {
        // What is already in the bottom bar is not repeated here.
        const items = g.items.filter((i) => !MOBILE.some((m) => m.match === i.match));
        return items.length ? <Group key={g.title} title={g.title} items={g.title === 'Planificar' ? [...items, MONEY_SETUP[1]!] : items} /> : null;
      })}
      {pending > 0 && <Group title="Por revisar" items={[REVIEW]} />}
      <Group title="Cuenta" items={[{ href: '/app/ajustes', match: '/app/ajustes', label: 'Ajustes', icon: 'settings' }]} />
    </main>
  );
}
