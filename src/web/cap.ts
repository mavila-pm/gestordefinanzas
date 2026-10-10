/** Cap anti-bot: names shared by the browser widget and the server checks (no secrets, no crypto here). */
export const CAP_SCOPES = ['login', 'signup', 'recovery'] as const;
export type CapScope = (typeof CAP_SCOPES)[number];
export const isCapScope = (s: unknown): s is CapScope => (CAP_SCOPES as readonly unknown[]).includes(s);
/** Form field the widget fills (data-cap-hidden-field-name). */
export const CAP_FIELD = 'cap-token';
/** The only thing a person sees when verification fails, whatever the reason. */
export const CAP_ERROR = 'No pudimos verificarte. Intenta otra vez.';
/** Widget labels (es-PE). No technical detail, no provider name. */
export const CAP_LABELS = {
  'initial-state': 'Confirma que eres una persona',
  'verifying-label': 'Verificando…',
  'solved-label': 'Verificado',
  'error-label': CAP_ERROR,
  'required-label': 'Primero confirma que eres una persona.',
  'troubleshooting-label': 'Ayuda',
  'group-aria-label': 'Verificación de seguridad',
  'verify-aria-label': 'Confirmar que eres una persona',
  'verifying-aria-label': 'Verificando…',
  'verified-aria-label': 'Verificado',
  'error-aria-label': CAP_ERROR,
  'wasm-disabled': 'Activa JavaScript completo en tu navegador para continuar.',
} as const;
