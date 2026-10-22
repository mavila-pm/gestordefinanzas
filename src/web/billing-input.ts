import type { PlanCode } from '../domain/billing';

/**
 * Untrusted checkout input (ADR-0018). Culqi needs a customer to save a card for Mensual/Anual: names, email and
 * phone come from the person's profile (registration), the address is asked in the form and never invented.
 * Card data never passes through here: Culqi Checkout returns only a token id.
 */
export interface BillingCustomer { firstName: string; lastName: string; phoneNumber: string; address: string; addressCity: string }

const TEXT = /^[^\u0000-\u001f\u007f<>]{2,100}$/u;
const clean = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').trim().replace(/\s+/g, ' ') : '');

/** Address + city from the form: 2–100 characters each, no control characters or markup. */
export function parseAddress(address: unknown, city: unknown): { address: string; addressCity: string } | { error: 'address' | 'city' } {
  const a = clean(address);
  const c = clean(city);
  if (!TEXT.test(a)) return { error: 'address' };
  if (!TEXT.test(c) || c.length > 60) return { error: 'city' };
  return { address: a, addressCity: c };
}

/** Peruvian mobile from the profile (+519XXXXXXXX) as the 9 national digits Culqi examples use (format UNVERIFIED). */
export function culqiPhone(e164: unknown): string | null {
  const m = typeof e164 === 'string' ? /^\+51(9[0-9]{8})$/.exec(e164) : null;
  return m ? m[1]! : null;
}

/** The Culqi customer for this person, or which piece is missing (the page asks for it; nothing is guessed). */
export function billingCustomer(
  profile: { given_names?: string | null; family_names?: string | null; phone_e164?: string | null } | null,
  address: unknown, city: unknown,
): BillingCustomer | { error: 'profile' | 'phone' | 'address' | 'city' } {
  const first = clean(profile?.given_names);
  const last = clean(profile?.family_names);
  if (!TEXT.test(first) || !TEXT.test(last)) return { error: 'profile' };
  const phone = culqiPhone(profile?.phone_e164);
  if (!phone) return { error: 'phone' };
  const a = parseAddress(address, city);
  if ('error' in a) return a;
  return { firstName: first, lastName: last, phoneNumber: phone, ...a };
}

/** A Culqi token id from the browser: shape only (mode and kind are re-checked by the server flow). */
export const isTokenId = (v: unknown): v is string => typeof v === 'string' && /^tkn_(test|live)_[A-Za-z0-9]{6,64}$/.test(v);

/** Fixed Spanish copy (es-PE) for every way a card checkout can end without success. Never the provider's text. */
export const CHECKOUT_COPY: Record<string, string> = {
  already_lifetime: 'Ya tienes Plus Vitalicio. No se hizo ningún cargo.',
  already_plus: 'Ya tienes Plus. Puedes ver tu plan en Ajustes → Plan y uso. No se hizo ningún cargo.',
  too_many_orders: 'Hiciste varios intentos seguidos. Espera unos minutos y vuelve a intentarlo.',
  payment_in_progress: 'Tienes un pago en proceso. Si en unos minutos tu plan no cambia, escríbenos y lo revisamos; no pagues de nuevo.',
  subscription_still_open: 'Tu suscripción anterior sigue activa en Culqi y podría volver a cobrarte. Cancela su renovación en Ajustes → Plan y uso y luego elige tu plan. No se hizo ningún cargo.',
  bad_plan: 'Elige un plan válido.',
  price_changed: 'El precio de este plan cambió. Revisa el nuevo precio antes de continuar.',
  order_not_pending: 'Este pago ya se está procesando. Revisa tu plan en unos segundos.',
  order_expired: 'Pasó mucho tiempo desde que empezaste. Vuelve a intentarlo. No se hizo ningún cargo.',
  order_not_found: 'No encontramos tu compra. Vuelve a intentarlo. No se hizo ningún cargo.',
  trial_no_longer_available: 'Ya usaste tu prueba gratis. Elige el plan sin prueba. No se hizo ningún cargo.',
  test_mode_demo_only: 'Los pagos de prueba solo están disponibles en cuentas demo. No se hizo ningún cargo.',
  price_config_mismatch: 'Este plan no está disponible para pago con tarjeta en este momento. No se hizo ningún cargo.',
  customer_rejected: 'Culqi no aceptó tus datos. Revisa tu dirección e inténtalo de nuevo. No se hizo ningún cargo.',
  bad_token: 'No pudimos leer tu tarjeta. Vuelve a intentarlo. No se hizo ningún cargo.',
  unavailable: 'No pudimos conectar con Culqi. Inténtalo en unos minutos. No se hizo ningún cargo.',
  refunded: 'No pudimos activar tu plan y te devolvimos el pago. Verás la devolución en tu tarjeta en unos días.',
  needs_refund: 'No pudimos activar tu plan. Revisaremos tu cobro y te lo devolveremos; escríbenos si tienes dudas.',
  disabled: 'Los pagos con tarjeta se habilitarán muy pronto. No se hizo ningún cargo.',
  terms: 'Para continuar, acepta los Términos y las condiciones de pago.',
  address: 'Escribe tu dirección (Culqi la pide para guardar tu tarjeta).',
  city: 'Escribe tu ciudad (Culqi la pide para guardar tu tarjeta).',
  profile: 'Completa tus nombres y apellidos en Ajustes → Perfil antes de suscribirte.',
  phone: 'Necesitamos tu celular peruano. Revísalo en Ajustes → Perfil antes de suscribirte.',
};
export const CHECKOUT_FALLBACK = 'No pudimos completar el pago. No se hizo ningún cargo. Inténtalo de nuevo.';

/** Copy for the checkout of a plan (shared by the page and the card button). */
export function consentText(plan: PlanCode, price: string, period: string, trialEnd: string | null): string {
  return plan === 'lifetime'
    ? `Acepto los Términos y el pago único de ${price}.`
    : `Acepto los Términos y que se cobre ${price} ${period}${trialEnd ? ` desde el ${trialEnd}` : ''} hasta que cancele. Puedo cancelar cuando quiera.`;
}
