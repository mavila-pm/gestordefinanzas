'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './ui/icon';
import { SETTINGS_SECTIONS } from './settings';

/** Desktop sidebar / mobile list of the nine Ajustes sections; the current one is marked. */
export function SettingsNav({ variant }: { variant: 'sidebar' | 'list' }) {
  const path = usePathname();
  return (
    <nav aria-label="Secciones de Ajustes" className={variant === 'sidebar' ? 'settings-nav' : 'settings-list'}>
      <ul className="plain">
        {SETTINGS_SECTIONS.map((s) => {
          const href = `/app/ajustes/${s.slug}`;
          const active = path === href || (variant === 'sidebar' && path === '/app/ajustes' && s.slug === 'perfil');
          return (
            <li key={s.slug}>
              <Link href={href} aria-current={active ? 'page' : undefined} data-testid={`settings-${s.slug}`}>
                <Icon name={s.icon} size={20} /><span>{s.label}</span>{variant === 'list' && <Icon name="chevron" size={18} />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * A device preference kept in a first-party cookie and applied on <html> at once (the root layout applies it on the
 * server too, so there is no flash). `apply` maps the choice to the document.
 */
function useCookieChoice<T extends string>(name: string, fallback: T, valid: readonly T[]) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    const m = new RegExp(`(?:^|; )${name}=([a-z]+)`).exec(document.cookie);
    if (m && (valid as readonly string[]).includes(m[1]!)) setValue(m[1] as T);
  }, [name, valid]);
  const save = (v: T) => {
    setValue(v);
    document.cookie = v === fallback ? `${name}=; path=/; max-age=0; samesite=lax` : `${name}=${v}; path=/; max-age=31536000; samesite=lax`;
  };
  return [value, save] as const;
}

function Segmented<T extends string>({ legend, name, options, value, onChange }: { legend: string; name: string; options: ReadonlyArray<readonly [T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <fieldset className="bare segmented settings-choice">
      <legend className="settings-row-label">{legend}</legend>
      <div className="segments" role="radiogroup">
        {options.map(([v, l]) => (
          <label key={v} className="segment">
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} data-testid={`${name}-${v}`} />
            <span>{l}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const MODES = ['system', 'light', 'dark'] as const;
export function ModeChoice() {
  const [mode, setMode] = useCookieChoice<(typeof MODES)[number]>('vs-theme', 'system', MODES);
  return <Segmented legend="Modo" name="mode" value={mode} options={[['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']]}
    onChange={(v) => { setMode(v); const dark = v === 'dark' || (v === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }} />;
}

const SIZES = ['sm', 'md', 'lg'] as const;
export function TextSizeChoice() {
  const [size, setSize] = useCookieChoice<(typeof SIZES)[number]>('vs-text', 'md', SIZES);
  return <Segmented legend="Tamaño del texto" name="text" value={size} options={[['sm', 'Pequeño'], ['md', 'Estándar'], ['lg', 'Grande']]}
    onChange={(v) => { setSize(v); if (v === 'md') delete document.documentElement.dataset.text; else document.documentElement.dataset.text = v; }} />;
}

const MOTION = ['auto', 'reduce'] as const;
export function MotionToggle() {
  const [motion, setMotion] = useCookieChoice<(typeof MOTION)[number]>('vs-motion', 'auto', MOTION);
  const [system, setSystem] = useState(false);
  useEffect(() => { setSystem(matchMedia('(prefers-reduced-motion: reduce)').matches); }, []);
  return (
    <label className="settings-switch">
      <span className="settings-row-text"><span className="settings-row-label">Reducir animaciones</span>
        <small className="muted">{system ? 'Tu dispositivo ya las reduce; Velsuno lo respeta.' : 'Menos movimiento al cambiar de pantalla y abrir paneles.'}</small></span>
      <input type="checkbox" role="switch" checked={motion === 'reduce' || system} disabled={system} data-testid="motion-switch"
        onChange={(e) => { const v = e.target.checked ? 'reduce' : 'auto'; setMotion(v); if (v === 'reduce') document.documentElement.dataset.motion = 'reduce'; else delete document.documentElement.dataset.motion; }} />
    </label>
  );
}
