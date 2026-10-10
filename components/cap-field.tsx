'use client';

import { useEffect, useRef } from 'react';
import { CAP_FIELD, CAP_LABELS, type CapScope } from '../src/web/cap';

type CapElement = HTMLElement & { reset?: () => void };
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'cap-widget': React.DetailedHTMLProps<React.HTMLAttributes<CapElement>, CapElement> & { required?: boolean };
    }
  }
}

/**
 * Anti-bot check for a public auth form (Cap). It starts solving on the first touch or key press, so it usually
 * says "Verificado" before the person finishes typing; the form cannot be sent until then (required). The server
 * action verifies the token again and spends it, so after every answer the widget is reset for a new one.
 * The solver runs from Velsuno's own files (no third-party CDN).
 */
export function CapField({ scope, resetKey }: { scope: CapScope; resetKey?: unknown }) {
  const ref = useRef<CapElement>(null);
  useEffect(() => {
    const w = window as Window & { CAP_CUSTOM_WASM_URL?: string; CAP_SILENT?: boolean };
    w.CAP_CUSTOM_WASM_URL ??= '/cap/cap_wasm_bg.wasm';
    w.CAP_SILENT = true;
    import('@cap.js/widget').catch(() => {});
  }, []);
  // Each server answer spent the token (valid or not): ask for a fresh one.
  useEffect(() => { if (resetKey) ref.current?.reset?.(); }, [resetKey]);
  const labels = Object.fromEntries(Object.entries(CAP_LABELS).map(([k, v]) => [`data-cap-i18n-${k}`, v]));
  return (
    <div className="cap-field" data-testid="cap-field">
      <cap-widget ref={ref} required data-cap-api-endpoint={`/api/cap/${scope}/`} data-cap-hidden-field-name={CAP_FIELD}
        data-cap-disable-haptics="" {...labels} />
    </div>
  );
}
