/**
 * Generates SYNTHETIC financial images for vision tests and the provider benchmark (ADR-0006, adenda §59, §75).
 * Every image is rendered from HTML with invented data, marked "DOCUMENTO SINTÉTICO", and card numbers masked.
 * Output: tests/fixtures/ai/vision/<case>.png + expected.json, and src/ai/providers/fixture-data.ts
 * (SHA-256 of the server-side cleaned bytes → the facts printed on the image).
 * Run: node --experimental-strip-types scripts/gen-vision-fixtures.ts
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { checkImage } from '../src/ai/image.ts';

interface Case { id: string; html: string; expected: Record<string, unknown>; blur?: boolean; width?: number }
const OUT = 'tests/fixtures/ai/vision';
mkdirSync(OUT, { recursive: true });

const shell = (title: string, rows: Array<[string, string]>, foot = '') => `
  <div style="font-family:Arial,sans-serif;padding:28px;width:520px;background:#fff;color:#1b1b1b">
    <div style="font-size:12px;color:#b00;letter-spacing:.08em">DOCUMENTO SINTÉTICO DE PRUEBA · NO REAL</div>
    <h2 style="margin:10px 0 18px">${title}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:18px">
      ${rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #ddd;color:#555">${k}</td><td style="padding:8px 0;border-bottom:1px solid #ddd;text-align:right;font-weight:bold">${v}</td></tr>`).join('')}
    </table>
    <p style="font-size:12px;color:#777;margin-top:16px">${foot}</p>
  </div>`;

const CASES: Case[] = [
  { id: 'card-bcp-pen', html: shell('Estado de cuenta · Tarjeta Visa BCP', [['Tarjeta', '•••• 4821'], ['Deuda total', 'S/ 2,430.00'], ['Pago mínimo', 'S/ 284.30'], ['Fecha de corte', '04/10/2026'], ['Último día de pago', '19/10/2026']]),
    expected: { document: 'card_statement', institution: 'BCP', last4: '4821', currency: 'PEN', balance: '2430.00', payment_minimum: '284.30', payment_total: '2430.00', due_date: '2026-10-19', cut_date: '2026-10-04', confidence: 'high', uncertain: [] } },
  { id: 'card-bbva-usd', html: shell('Estado de cuenta · Mastercard BBVA (dólares)', [['Tarjeta', '•••• 1177'], ['Deuda total', 'US$ 350.00'], ['Pago mínimo', 'US$ 25.00'], ['Pagar hasta', '05/10/2026']]),
    expected: { document: 'card_statement', institution: 'BBVA', last4: '1177', currency: 'USD', balance: '350.00', payment_minimum: '25.00', due_date: '2026-10-05', confidence: 'high', uncertain: [] } },
  { id: 'card-bcp-blurry', blur: true, html: shell('Estado de cuenta · Tarjeta Visa BCP', [['Tarjeta', '•••• 4821'], ['Deuda total', 'S/ 2,430.00'], ['Pago mínimo', 'S/ 284.30'], ['Último día de pago', '19/10/2026']]),
    expected: { document: 'card_statement', institution: 'BCP', last4: '4821', currency: 'PEN', balance: '2430.00', payment_minimum: '284.30', due_date: '2026-10-19', confidence: 'low', uncertain: ['payment_minimum', 'due_date'] } },
  { id: 'card-missing-minimum', html: shell('Resumen de tarjeta · Interbank', [['Tarjeta', '•••• 5503'], ['Deuda total', 'S/ 1,120.50'], ['Último día de pago', '22/10/2026']]),
    expected: { document: 'card_statement', institution: 'INTERBANK', last4: '5503', currency: 'PEN', balance: '1120.50', payment_minimum: null, due_date: '2026-10-22', confidence: 'medium', uncertain: [] } },
  { id: 'loan-interbank', html: shell('Cronograma de préstamo personal · Interbank', [['Saldo de capital', 'S/ 12,500.00'], ['Cuota del mes', 'S/ 850.00'], ['Vencimiento', '15/10/2026'], ['Cuotas pendientes', '16']]),
    expected: { document: 'loan', institution: 'INTERBANK', currency: 'PEN', balance: '12500.00', amount: '850.00', due_date: '2026-10-15', confidence: 'high', uncertain: [] } },
  { id: 'bill-luz', html: shell('Recibo de luz · Luz del Sur', [['Suministro', '•••• 3321'], ['Total a pagar', 'S/ 160.40'], ['Vence', '18/10/2026']]),
    expected: { document: 'bill', merchant: 'Luz del Sur', currency: 'PEN', amount: '160.40', due_date: '2026-10-18', confidence: 'high', uncertain: [] } },
  { id: 'bill-internet', html: shell('Recibo · Movistar Internet Hogar', [['Total del mes', 'S/ 99.90'], ['Fecha de vencimiento', '13/10/2026']]),
    expected: { document: 'bill', merchant: 'Movistar', currency: 'PEN', amount: '99.90', due_date: '2026-10-13', confidence: 'high', uncertain: [] } },
  { id: 'receipt-market', html: shell('Boleta de venta · Supermercado (sintético)', [['Arroz 5kg', 'S/ 24.90'], ['Aceite 1L', 'S/ 11.60'], ['Pollo', 'S/ 50.00'], ['TOTAL', 'S/ 86.50']], 'Fecha 27/09/2026'),
    expected: { document: 'receipt', merchant: 'Supermercado', currency: 'PEN', amount: '86.50', confidence: 'high', uncertain: [] } },
  { id: 'bank-screen-bcp', html: shell('Banca móvil BCP · Cuenta de ahorros', [['Cuenta', '•••• 0012'], ['Saldo disponible', 'S/ 3,250.75']]),
    expected: { document: 'bank_screen', institution: 'BCP', currency: 'PEN', balance: '3250.75', confidence: 'high', uncertain: [] } },
  { id: 'card-two-currencies', html: shell('Estado de cuenta bimoneda · Visa BCP', [['Tarjeta', '•••• 4821'], ['Deuda en soles', 'S/ 1,200.00'], ['Deuda en dólares', 'US$ 80.00'], ['Pago mínimo (soles)', 'S/ 120.00'], ['Último día de pago', '19/10/2026']]),
    expected: { document: 'card_statement', institution: 'BCP', last4: '4821', currency: 'PEN', balance: '1200.00', payment_minimum: '120.00', due_date: '2026-10-19', confidence: 'medium', uncertain: ['currency'] } },
];

const root = '/opt/pw-browsers';
const dir = existsSync(root) ? readdirSync(root).find((d) => /^chromium-\d+$/.test(d)) : undefined;
const browser = await chromium.launch({ executablePath: dir ? `${root}/${dir}/chrome-linux/chrome` : undefined });
const page = await browser.newPage({ viewport: { width: 600, height: 520 }, deviceScaleFactor: 1 });
const fixtures: Record<string, unknown> = {};
const expected: Record<string, unknown> = {};
for (const c of CASES) {
  await page.setContent(`<body style="margin:0;background:#eee">${c.blur ? '<div style="filter:blur(2.2px)">' : '<div>'}${c.html}</div></body>`);
  const png = await page.locator('body > div').screenshot({ type: 'png' });
  writeFileSync(`${OUT}/${c.id}.png`, png);
  const check = checkImage(new Uint8Array(png));
  if (!check.ok) throw new Error(`${c.id}: ${check.error}`);
  const hash = createHash('sha256').update(check.bytes).digest('hex');
  fixtures[hash] = c.expected;
  expected[c.id] = { sha256: hash, ...c.expected };
}
await browser.close();
writeFileSync(`${OUT}/expected.json`, JSON.stringify(expected, null, 2) + '\n');
writeFileSync('src/ai/providers/fixture-data.ts', `/** SHA-256 of synthetic test images (tests/fixtures/ai/vision) → the facts printed on them. Generated by scripts/gen-vision-fixtures.ts. */
export const VISION_FIXTURES: Record<string, Record<string, unknown>> = ${JSON.stringify(fixtures, null, 2)};
`);
console.log(`vision fixtures: ${CASES.length} synthetic images`);
