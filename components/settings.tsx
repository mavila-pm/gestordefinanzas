import Link from 'next/link';
import { Icon } from './ui/icon';

/** Ajustes building blocks: a titled group of rows, one row, a usage meter. Velsuno tokens only. */
export function SettingsSection({ title, description, children, testId }: { title: string; description?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="settings-section" aria-label={title} data-testid={testId}>
      <h2 className="settings-section-title">{title}</h2>
      {description && <p className="muted small">{description}</p>}
      <div className="settings-rows">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, value, hint, action, href }: { label: string; value?: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; href?: string }) {
  const body = (
    <>
      <span className="settings-row-text"><span className="settings-row-label">{label}</span>{hint && <small className="muted">{hint}</small>}</span>
      {value !== undefined && <span className="settings-row-value">{value}</span>}
      {action}
      {href && <Icon name="chevron" size={18} />}
    </>
  );
  return href ? <Link href={href} className="settings-row link-row">{body}</Link> : <div className="settings-row">{body}</div>;
}

/** "Uso de Vels": percent used and when it renews. Text says the number; the bar only repeats it. */
export function UsageMeter({ percent, resetLabel }: { percent: number | null; resetLabel: string | null }) {
  return (
    <div className="usage-meter" data-testid="vels-usage">
      <div className="row"><strong>Uso de Vels</strong><span data-testid="vels-usage-percent">{percent === null ? 'Sin límite definido' : `${percent} % usado`}</span></div>
      {percent !== null && (
        <span className="progress" role="progressbar" aria-label="Uso de Vels" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span className={`fill${percent >= 100 ? ' exceeded' : percent >= 80 ? ' warning' : ''}`} style={{ width: `${Math.max(percent, 2)}%` }} />
        </span>
      )}
      {resetLabel && <small className="muted">{resetLabel}</small>}
    </div>
  );
}

/** Settings index entries (mobile list, desktop sidebar): the single source of the nine sections. */
export const SETTINGS_SECTIONS = [
  { slug: 'perfil', label: 'Perfil', icon: 'user' },
  { slug: 'plan', label: 'Plan y uso', icon: 'gauge' },
  { slug: 'vels', label: 'Vels', icon: 'chat' },
  { slug: 'finanzas', label: 'Finanzas', icon: 'wallet' },
  { slug: 'apariencia', label: 'Apariencia', icon: 'palette' },
  { slug: 'notificaciones', label: 'Notificaciones', icon: 'bell' },
  { slug: 'accesibilidad', label: 'Accesibilidad', icon: 'text' },
  { slug: 'seguridad', label: 'Seguridad', icon: 'shield' },
  { slug: 'privacidad', label: 'Privacidad y datos', icon: 'doc' },
] as const;

/** One Ajustes screen: back to the list on mobile, the title, then its sections. */
export function SettingsPage({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <main className="stack" id="main" data-testid={testId}>
      <div>
        <Link href="/app/ajustes" className="settings-back"><Icon name="back" size={18} />Ajustes</Link>
        <h1>{title}</h1>
      </div>
      {children}
    </main>
  );
}

export function Avatar({ name, size = 40 }: { name: string | null; size?: number }) {
  return <span className="avatar-initial" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">{(name ?? '·').slice(0, 1).toLocaleUpperCase('es')}</span>;
}
