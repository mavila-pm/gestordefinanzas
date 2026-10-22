/**
 * FIXTURE STATUS: SYNTHETIC_FIXTURE. NOTHING about BBVA Perú is observed: wording, labels, sender domain and SMS sender
 * are invented to exercise the multi-bank architecture (domain uses the reserved `.example` TLD). No real person,
 * card, account or operation. Never present these as real BBVA coverage.
 */
export const FIXTURE_STATUS = 'SYNTHETIC_FIXTURE' as const;
import type { RawFinancialEvent } from '../../src/domain/types';

export const BBVA_SENDER = 'BBVA Notificaciones <avisos@bbva-sintetico.example>';
export const BBVA_SMS_SENDER = 'SINTETICO';

interface EmailOpts {
  id?: string;
  subject: string;
  lines: string[];
  sender?: string;
  receivedAt?: string;
}

export function bbvaEmail(o: EmailOpts): RawFinancialEvent {
  return {
    channel: 'email',
    externalEventId: o.id ?? `<${Math.random().toString(36).slice(2)}@bbva.test>`,
    sender: o.sender ?? BBVA_SENDER,
    subject: o.subject,
    body: ['Hola, CLIENTE DE PRUEBA', ...o.lines, 'BBVA Perú (texto sintético de prueba)'].join('\n'),
    receivedAt: o.receivedAt ?? '2026-09-16T01:31:00Z',
  };
}

export function bbvaSms(body: string, sender = BBVA_SMS_SENDER, receivedAt = '2026-09-16T01:31:00Z'): RawFinancialEvent {
  return { channel: 'sms', sender, body, receivedAt };
}

/** App notification pasted by the person: title line "BBVA" + text, sent through the SMS/notification field. */
export function bbvaPush(text: string, receivedAt = '2026-09-16T01:31:00Z'): RawFinancialEvent {
  return { channel: 'sms', sender: 'user-import:sms', body: `BBVA\n${text}`, receivedAt };
}

const purchase = (kind: 'Crédito' | 'Débito', amount: string, merchant: string, id: string, card = '**** 1234', when = ['15/09/2026', '20:30']) => bbvaEmail({
  id,
  subject: `Compra realizada con tu Tarjeta de ${kind} BBVA`,
  lines: [
    `Compra realizada con tu Tarjeta de ${kind} BBVA.`,
    `Importe: ${amount}`,
    `Comercio: ${merchant}`,
    `Tarjeta: ${card}`,
    `Fecha: ${when[0]}`,
    `Hora: ${when[1]}`,
    `Número de operación: ${id.replace(/\D/g, '').padStart(6, '0').slice(-6)}`,
  ],
});

export const purchaseCreditPenEmail = (id = '<bbva-cc-pen-101@bbva.test>') => purchase('Crédito', 'S/ 45.90', 'TAMBO MIRAFLORES', id);
export const purchaseCreditUsdEmail = () => purchase('Crédito', 'US$ 1,250.99', 'PAYU*NETFLIX', '<bbva-cc-usd-102@bbva.test>');
export const purchaseDebitPenEmail = () => purchase('Débito', 'PEN 80.00', 'PLAZA VEA SURCO', '<bbva-db-pen-103@bbva.test>', '**** 5678');
export const purchaseDebitUsdEmail = () => purchase('Débito', 'USD 30.00', 'STEAM GAMES', '<bbva-db-usd-104@bbva.test>', '**** 5678');

export const purchaseCreditPenSms = () => bbvaSms('BBVA: Compra de S/ 45.90 con Tarjeta de Credito *1234 en TAMBO MIRAFLORES el 15/09/2026 20:31.');
export const purchaseDebitSms = () => bbvaSms('BBVA: Compra de US$ 12.00 con Tarjeta de Débito *5678 en SPOTIFY el 14/09/2026 09:15.');

export const cardPaymentEmail = () => bbvaEmail({
  id: '<bbva-payment-105@bbva.test>',
  subject: 'Pago de tu Tarjeta de Crédito registrado - BBVA',
  lines: ['Pago de tu Tarjeta de Crédito registrado.', 'Importe: S/ 300.00', 'Tarjeta: **** 1234', 'Fecha: 25/09/2026', 'Hora: 09:00', 'Número de operación: 000105'],
});

export const transferEmail = (destLast4: string) => bbvaEmail({
  id: `<bbva-transfer-${destLast4}@bbva.test>`,
  subject: 'Transferencia enviada - BBVA',
  lines: ['Transferencia enviada desde tu cuenta BBVA.', 'Importe: S/ 500.00', `Cuenta destino: **** ${destLast4}`, 'Fecha: 10/09/2026', 'Hora: 10:00', `Número de operación: 06${destLast4}`],
});

export const withdrawalEmail = () => bbvaEmail({
  id: '<bbva-atm-107@bbva.test>',
  subject: 'Retiro en cajero automático - BBVA',
  lines: ['Retiro en cajero automático con tu tarjeta BBVA.', 'Importe: S/ 200.00', 'Fecha: 12/09/2026', 'Hora: 19:15', 'Número de operación: 000107'],
});

export const depositEmail = () => bbvaEmail({
  id: '<bbva-deposit-108@bbva.test>',
  subject: 'Abono recibido en tu cuenta - BBVA',
  lines: ['Abono recibido en tu cuenta BBVA.', 'Importe: S/ 5,500.00', 'Fecha: 01/09/2026', 'Hora: 09:00', 'Número de operación: 000108'],
});

export const refundEmail = (amount = 'S/ 20.00') => bbvaEmail({
  id: '<bbva-refund-109@bbva.test>',
  subject: 'Devolución de compra en tu Tarjeta BBVA',
  lines: ['Devolución de compra en tu Tarjeta BBVA.', `Importe: ${amount}`, 'Comercio: TAMBO MIRAFLORES', 'Tarjeta: **** 1234', 'Fecha: 18/09/2026', 'Hora: 11:00', 'Número de operación: 000109'],
});

export const reversalEmail = () => bbvaEmail({
  id: '<bbva-reversal-110@bbva.test>',
  subject: 'Extorno de operación en tu Tarjeta BBVA',
  lines: ['Extorno de operación en tu Tarjeta BBVA.', 'Importe: S/ 45.90', 'Comercio: TAMBO MIRAFLORES', 'Tarjeta: **** 1234', 'Fecha: 16/09/2026', 'Hora: 08:00', 'Número de operación: 000110'],
});

export const securityEmail = () => bbvaEmail({
  id: '<bbva-security-111@bbva.test>',
  subject: 'Nuevo inicio de sesión en tu Banca por Internet BBVA',
  lines: ['Detectamos un nuevo inicio de sesión en tu Banca por Internet.', 'Si no fuiste tú, comunícate con nosotros.'],
});

export const marketingEmail = () => bbvaEmail({
  id: '<bbva-promo-112@bbva.test>',
  subject: 'BBVA: aprovecha esta promoción',
  lines: ['Aprovecha 20% de descuento en restaurantes con tu tarjeta.'],
});

export const unknownTemplateEmail = () => bbvaEmail({
  id: '<bbva-unknown-113@bbva.test>',
  subject: 'BBVA: movimiento en tu cuenta',
  lines: ['Se registró un movimiento en tu cuenta.', 'Importe: S/ 20.00'],
});

export const malformedEmail = () => bbvaEmail({
  id: '<bbva-malformed-114@bbva.test>',
  subject: 'Compra realizada con tu Tarjeta de Crédito BBVA',
  lines: ['Compra realizada con tu Tarjeta de Crédito BBVA.', 'Importe: S/ cuarenta', 'Comercio: TAMBO', 'Tarjeta: **** 1234', 'Fecha: ayer', 'Hora: 20:30'],
});
