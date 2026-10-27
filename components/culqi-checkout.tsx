'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { payWithCardAction, startCardOrderAction } from '../app/app/planes/actions';
import { CULQI_CHECKOUT_SCRIPT } from '../src/billing/culqi-public';
import type { PlanCode } from '../src/domain/billing';

/**
 * Card payment with Culqi Checkout Custom (ADR-0019). Culqi's own window collects the card and returns a token
 * (tkn_…): Velsuno never sees card data. Order of events: terms accepted → the server creates the order at its
 * price → Checkout opens showing that amount → token → the server charges the STORED amount (or subscribes) →
 * the gracias page reads the result from the database. Never optimistic: no success is shown before the server.
 *
 * UNVERIFIED (Checkout v4 shape, from Culqi's published examples): `new CulqiCheckout(publicKey, config)`, the
 * `culqi` callback reading `instance.token.id` / `instance.error`, `open()` / `close()`, paymentMethods keys.
 */
interface CulqiInstance {
  open(): void;
  close(): void;
  culqi?: () => void;
  token?: { id?: unknown } | null;
  error?: unknown;
}
type CulqiCtor = new (publicKey: string, config: Record<string, unknown>) => CulqiInstance;

let scriptPromise: Promise<CulqiCtor> | null = null;
function loadCheckout(): Promise<CulqiCtor> {
  const w = window as Window & { CulqiCheckout?: CulqiCtor };
  if (w.CulqiCheckout) return Promise.resolve(w.CulqiCheckout);
  scriptPromise ??= new Promise<CulqiCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CULQI_CHECKOUT_SCRIPT;
    s.async = true;
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    s.onload = () => { clearTimeout(timer); w.CulqiCheckout ? resolve(w.CulqiCheckout) : reject(new Error('missing')); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
    document.head.appendChild(s);
  }).catch((e) => { scriptPromise = null; throw e; });
  return scriptPromise;
}

const LOAD_ERROR = 'No pudimos abrir el pago seguro de Culqi. Revisa tu conexión e inténtalo de nuevo. No se hizo ningún cargo.';
const CARD_ERROR = 'Culqi no pudo leer tu tarjeta. Revisa los datos e inténtalo de nuevo. No se hizo ningún cargo.';

export function CulqiCheckoutButton(props: {
  plan: PlanCode;
  amountMinor: number;
  publicKey: string;
  testMode: boolean;
  consent: string;
  buttonLabel: string;
  title: string;
}) {
  const router = useRouter();
  const [terms, setTerms] = useState(false);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState<null | 'preparing' | 'paying'>(null);
  const [error, setError] = useState<string | null>(null);
  const instance = useRef<CulqiInstance | null>(null);
  const recurring = props.plan !== 'lifetime';

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy('preparing');
    const order = await startCardOrderAction({ plan: props.plan, amount: props.amountMinor, terms, address, city }).catch(() => null);
    if (!order || !order.ok) { setBusy(null); setError(order?.error ?? LOAD_ERROR); return; }
    let Ctor: CulqiCtor;
    try { Ctor = await loadCheckout(); } catch { setBusy(null); setError(LOAD_ERROR); return; }
    const paymentMethods = { tarjeta: true, yape: false, billetera: false, bancaMovil: false, agente: false, cuotealo: false };
    const culqi = new Ctor(props.publicKey, {
      settings: { title: 'Velsuno', currency: order.currency, amount: order.amountMinor },
      client: {},
      options: { lang: 'auto', installments: false, modal: true, paymentMethods, paymentMethodsSort: ['tarjeta'] },
      appearance: {},
    });
    instance.current = culqi;
    culqi.culqi = () => {
      const token = culqi.token?.id;
      if (typeof token !== 'string') { setBusy(null); if (culqi.error) setError(CARD_ERROR); return; }
      culqi.close();
      setBusy('paying');
      payWithCardAction({ orderId: order.orderId, tokenId: token, address, city })
        .then((r) => { if (r.ok) router.push(r.redirectTo); else { setBusy(null); setError(r.error); } })
        // The request may have reached the server: never claim "no charge" here; the order page tells the truth.
        .catch(() => router.push(`/app/planes/gracias?pedido=${order.orderId}`));
    };
    setBusy(null);
    culqi.open();
  }

  return (
    <form className="stack" onSubmit={start} aria-busy={busy !== null} aria-label={props.title} data-testid="card-checkout">
      {props.testMode && <p className="notice" data-testid="test-mode">Modo de prueba de Culqi: usa una tarjeta de prueba. No se cobra dinero real.</p>}
      <fieldset disabled={busy !== null} className="bare stack">
        {recurring && (
          <>
            <label className="stack-sm">
              <span>Dirección</span>
              <input name="address" autoComplete="street-address" required minLength={2} maxLength={100} value={address} onChange={(e) => setAddress(e.target.value)} data-testid="billing-address" />
            </label>
            <label className="stack-sm">
              <span>Ciudad</span>
              <input name="city" autoComplete="address-level2" required minLength={2} maxLength={60} value={city} onChange={(e) => setCity(e.target.value)} data-testid="billing-city" />
            </label>
            <p className="muted small">Culqi pide tu dirección para guardar tu tarjeta.</p>
          </>
        )}
        <label className="check-row">
          <input type="checkbox" name="terms" required checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="terms" />
          <span>{props.consent} <Link href="/terminos">Ver Términos</Link></span>
        </label>
        <button type="submit" data-testid="pay">{busy === 'preparing' ? 'Abriendo pago seguro…' : busy === 'paying' ? 'Procesando tu pago…' : props.buttonLabel}</button>
      </fieldset>
      {busy === 'paying' && <p role="status" className="muted small">Estamos confirmando con Culqi. No cierres esta página.</p>}
      {error && <p role="alert" className="error" data-testid="pay-error">{error}</p>}
      <p className="muted small">Pago seguro con Culqi. Velsuno no ve ni guarda los datos de tu tarjeta.</p>
    </form>
  );
}
