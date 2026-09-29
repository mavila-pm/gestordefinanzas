'use client';

import { useEffect, useState } from 'react';

type Choice = 'system' | 'light' | 'dark';
const COOKIE = 'vs-theme';
const LABEL: Record<Choice, string> = { system: 'Automático', light: 'Claro', dark: 'Oscuro' };

function apply(choice: Choice) {
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.cookie = choice === 'system' ? `${COOKIE}=; path=/; max-age=0; samesite=lax` : `${COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}

/** Light / dark / system. Persisted in a first-party cookie so the server renders the right theme (no flash). */
export function ThemeControl({ hideLegend }: { hideLegend?: boolean }) {
  const [choice, setChoice] = useState<Choice>('system');
  useEffect(() => {
    const m = /(?:^|; )vs-theme=(light|dark)/.exec(document.cookie);
    setChoice((m?.[1] as Choice | undefined) ?? 'system');
  }, []);
  return (
    <fieldset className="bare segmented" aria-label="Apariencia">
      <legend className={hideLegend ? 'sr-only' : 'label'}>Apariencia</legend>
      <div className="segments" role="radiogroup">
        {(Object.keys(LABEL) as Choice[]).map((c) => (
          <label key={c} className="segment">
            <input type="radio" name="theme" value={c} checked={choice === c} onChange={() => { setChoice(c); apply(c); }} />
            <span>{LABEL[c]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
