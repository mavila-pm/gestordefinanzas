/**
 * SYNTHETIC, ANONYMIZED BCP fixtures. No real person, card, account or operation.
 * Layout mirrors the templates assumed in src/ingestion/adapters/bcp (pending validation
 * against real anonymized samples).
 */
import type { RawFinancialEvent } from '../../src/domain/types';

export const BCP_SENDER = 'BCP Notificaciones <notificaciones@notificacionesbcp.com.pe>';

interface EmailOpts {
  id?: string;
  subject: string;
  lines: string[];
  sender?: string;
  receivedAt?: string;
}

export function bcpEmail(o: EmailOpts): RawFinancialEvent {
  return {
    channel: 'email',
    externalEventId: o.id ?? `<${Math.random().toString(36).slice(2)}@mail.test>`,
    sender: o.sender ?? BCP_SENDER,
    subject: o.subject,
    body: ['Hola, CLIENTE DE PRUEBA', ...o.lines, 'Banco de Crédito del Perú - BCP'].join('\n'),
    receivedAt: o.receivedAt ?? '2026-09-16T01:31:00Z',
  };
}

export function bcpSms(body: string, sender = 'BCP', receivedAt = '2026-09-16T01:31:00Z'): RawFinancialEvent {
  return { channel: 'sms', sender, body, receivedAt };
}

export const purchasePenEmail = (id = '<purchase-pen-1@mail.test>') => bcpEmail({
  id,
  subject: 'Realizaste un consumo con tu Tarjeta de Crédito BCP',
  lines: [
    'Realizaste un consumo con tu Tarjeta de Crédito BCP.',
    'Monto: S/ 100.00',
    'Empresa: RESTAURANTE EL EJEMPLO S.A.C.',
    'Número de Tarjeta de Crédito: ************4821',
    'Fecha y hora: 15 de septiembre de 2026 - 08:30 PM',
    'Número de operación: 000111',
  ],
});

export const purchasePenSms = () => bcpSms(
  'BCP: Realizaste un consumo de S/ 100.00 con tu Tarjeta de Credito *4821 en RESTAURANTE EL EJEMPLO el 15/09/2026 20:31.',
);

export const purchaseUsdEmail = () => bcpEmail({
  id: '<purchase-usd-1@mail.test>',
  subject: 'Realizaste un consumo con tu Tarjeta de Crédito BCP',
  lines: [
    'Realizaste un consumo con tu Tarjeta de Crédito BCP.',
    'Monto: US$ 1,250.99',
    'Empresa: PAYU*NETFLIX',
    'Número de Tarjeta de Crédito: ************4821',
    'Fecha y hora: 2 de septiembre de 2026 - 12:05 AM',
    'Número de operación: 000222',
  ],
});

export const cardPaymentEmail = () => bcpEmail({
  id: '<card-payment-1@mail.test>',
  subject: 'Realizaste un pago de tu Tarjeta de Crédito BCP',
  lines: [
    'Realizaste un pago de tu Tarjeta de Crédito BCP.',
    'Monto: S/ 100.00',
    'Número de Tarjeta de Crédito: ************4821',
    'Fecha y hora: 25 de septiembre de 2026 - 09:00 AM',
    'Número de operación: 000333',
  ],
});

export const transferEmail = (destLast4: string) => bcpEmail({
  id: `<transfer-${destLast4}@mail.test>`,
  subject: 'Realizaste una transferencia - BCP',
  lines: [
    'Realizaste una transferencia desde tu cuenta BCP.',
    'Monto: S/ 500.00',
    `Cuenta destino: ****${destLast4}`,
    'Fecha y hora: 10 de septiembre de 2026 - 10:00 AM',
    'Número de operación: 000444',
  ],
});

export const depositEmail = () => bcpEmail({
  id: '<deposit-1@mail.test>',
  subject: 'Recibiste un depósito - BCP',
  lines: ['Recibiste un depósito en tu cuenta BCP.', 'Monto: S/ 5,500.00', 'Fecha y hora: 1 de septiembre de 2026 - 09:00 AM', 'Número de operación: 000555'],
});

export const withdrawalEmail = () => bcpEmail({
  id: '<withdrawal-1@mail.test>',
  subject: 'Realizaste un retiro - BCP',
  lines: ['Realizaste un retiro en cajero BCP.', 'Monto: S/ 200.00', 'Fecha y hora: 12 de septiembre de 2026 - 07:15 PM', 'Número de operación: 000666'],
});

export const refundEmail = (amount = '40.00') => bcpEmail({
  id: `<refund-${amount}@mail.test>`,
  subject: 'Se realizó una devolución a tu Tarjeta de Crédito BCP',
  lines: [
    'Se realizó una devolución a tu Tarjeta de Crédito BCP.',
    `Monto: S/ ${amount}`,
    'Empresa: RESTAURANTE EL EJEMPLO S.A.C.',
    'Número de Tarjeta de Crédito: ************4821',
    'Fecha y hora: 18 de septiembre de 2026 - 11:00 AM',
    'Número de operación: 000777',
  ],
});

export const reversalEmail = () => bcpEmail({
  id: '<reversal-1@mail.test>',
  subject: 'Se realizó un extorno a tu Tarjeta de Crédito BCP',
  lines: [
    'Se realizó un extorno a tu Tarjeta de Crédito BCP.',
    'Monto: S/ 100.00',
    'Empresa: RESTAURANTE EL EJEMPLO S.A.C.',
    'Número de Tarjeta de Crédito: ************4821',
    'Fecha y hora: 16 de septiembre de 2026 - 08:00 AM',
    'Número de operación: 000888',
  ],
});

export const unknownTemplateEmail = () => bcpEmail({
  id: '<unknown-1@mail.test>',
  subject: 'BCP: Nuevas promociones para ti',
  lines: ['Aprovecha 20% de descuento en restaurantes.', 'Monto: S/ 20.00'],
});

export const malformedEmail = () => bcpEmail({
  id: '<malformed-1@mail.test>',
  subject: 'Realizaste un consumo con tu Tarjeta de Crédito BCP',
  lines: ['Realizaste un consumo con tu Tarjeta de Crédito BCP.', 'Monto: S/ cien soles', 'Fecha y hora: ayer'],
});
