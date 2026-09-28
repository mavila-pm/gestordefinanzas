/**
 * TASK-009 (UI) + TASK-010 + TASK-011 + TASK-012 end-to-end against the REAL Supabase project.
 * Seed: A has a confirmed Alimentación expense of S/ 400.00 this month; B has a budget, a debt and a subscription.
 * The app runs WITHOUT INBOUND_EMAIL_SECRET/DATABASE_URL (webhook must answer 503).
 * Run: node --experimental-strip-types tests/e2e/planning-account.e2e.ts
 */
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import { existsSync, readdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const A = process.env.E2E_A_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!A || !PASSWORD || !SUPABASE_URL || !SUPABASE_KEY) throw new Error('missing E2E env');

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push([name, ok, detail]); };
function chromiumPath(): string | undefined {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const p = dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
  return p && existsSync(p) ? p : undefined;
}
const limaToday = new Date(Date.now() - 5 * 3600_000);
const dueTomorrow = String(Math.min(limaToday.getUTCDate() + 1, 28));

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500); };
/** Server actions re-render in place: wait until the element's text actually changes. */
const changed = async (testId: string, before: string) => page.waitForFunction(
  ([id, old]) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '') !== old, [testId, before], { timeout: 15000 });

const webhook = await page.request.post(`${BASE}/api/inbound/email`, { data: { deliveryId: 'x', to: 'f_x@x.pe' } });
check('webhook disabled without server secrets (503)', webhook.status() === 503, String(webhook.status()));

await page.goto(`${BASE}/login`);
await page.fill('input[name=email]', A);
await page.fill('input[name=password]', PASSWORD);
await Promise.all([page.waitForURL(/\/app/), page.click('button[type=submit]')]);

// ── Budgets ──────────────────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app/presupuestos`);
const bf = 'form[aria-label="Guardar presupuesto"]';
await page.selectOption(`${bf} select[name=categoryId]`, { label: 'Alimentación' });
await page.fill(`${bf} input[name=amount]`, '350');
await page.click(`${bf} button[type=submit]`);
await settle();
const blist = (await page.getByTestId('budget-list').textContent()) ?? '';
check('budget shows S/ 400.00 / S/ 350.00 exceeded', blist.includes('S/ 400.00 / S/ 350.00') && blist.includes('Excedido por S/ 50.00'), blist);
await page.goto(`${BASE}/app`);
check('dashboard alert: budget exceeded', ((await page.locator('[data-alert="budget_exceeded:Alimentación"]').textContent()) ?? '').includes('Presupuesto excedido'));

// ── Commitments ─────────────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app/compromisos`);
await page.click('text=Agregar gasto fijo');
const ff = 'form[aria-label="Agregar gasto fijo"]';
await page.fill(`${ff} input[name=name]`, 'E2E Alquiler');
await page.fill(`${ff} input[name=amount]`, '1500');
await page.fill(`${ff} input[name=dueDay]`, '5');
await page.click(`${ff} button[type=submit]`);
await settle();
await page.click('text=Agregar deuda');
const df = 'form[aria-label="Agregar deuda"]';
await page.fill(`${df} input[name=name]`, 'E2E Préstamo');
await page.fill(`${df} input[name=principal]`, '30000');
await page.fill(`${df} input[name=balance]`, '18000');
await page.fill(`${df} input[name=installment]`, '1000');
await page.fill(`${df} input[name=installmentsTotal]`, '36');
await page.fill(`${df} input[name=installmentsPaid]`, '12');
await page.fill(`${df} input[name=dueDay]`, dueTomorrow);
const totalBefore = (await page.getByTestId('commitment-total').textContent()) ?? '';
await page.click(`${df} button[type=submit]`);
await changed('commitment-total', totalBefore);
check('commitment total = rent + installment', ((await page.getByTestId('commitment-total').textContent()) ?? '').includes('S/ 2,500.00'),
  (await page.getByTestId('commitment-total').textContent()) ?? '');
const debtBefore = (await page.getByTestId('debt').textContent()) ?? '';
await page.fill('form[aria-label="Pago E2E Préstamo"] input[name=amount]', '1000');
await page.click('form[aria-label="Pago E2E Préstamo"] button[type=submit]');
await changed('debt', debtBefore);
const debt = (await page.getByTestId('debt').textContent()) ?? '';
check('debt payment updates balance and installments only', debt.includes('Saldo S/ 17,000.00') && debt.includes('cuota 13/36') && debt.includes('Pagado S/ 13,000.00'), debt);
await page.goto(`${BASE}/app`);
check('dashboard commitments card', ((await page.getByTestId('commitments').textContent()) ?? '').includes('2 pago(s)'));
check('dashboard alert: debt due soon', (await page.locator('[data-alert^="debt_due:"]').count()) === 1);
check('commitments never change expenses (still S/ 400.00)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 400.00', (await page.getByTestId('expenses-PEN').textContent()) ?? '');

// ── Account / plan ──────────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app/cuenta`);
check('Free plan with limits shown', ((await page.getByTestId('plan').textContent()) ?? '').includes('Plan Free') && (await page.getByTestId('auto-usage').textContent()) === '0 / 50');
await page.click('form[aria-label="Probar Plus"] button');
await settle();
await page.reload();
check('trial active with exact end date', ((await page.getByTestId('plan').textContent()) ?? '').includes('Plan Plus (prueba)') && (await page.getByTestId('trial-end').count()) === 1);
check('trial cannot be offered again', (await page.locator('form[aria-label="Probar Plus"]').count()) === 0);

// ── Connections ─────────────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app/conexiones`);
check('bridge honestly marked unavailable', ((await page.getByTestId('bridge-status').textContent()) ?? '').includes('Aún no disponible'));
await page.click('form[aria-label="Generar dirección"] button');
await settle();
const a1 = (await page.getByTestId('bridge-address').textContent()) ?? '';
await page.click('form[aria-label="Generar dirección"] button');
await changed('bridge-address', a1);
const a2 = (await page.getByTestId('bridge-address').textContent()) ?? '';
check('private address generated (120-bit) and rotated', /f_[a-z2-7]{24}@/.test(a1) && /f_[a-z2-7]{24}@/.test(a2) && a1 !== a2, `${a1} | ${a2}`);
await browser.close();

// ── A/B and client write attempts through the API ───────────────────────────────────────────────────
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: A, password: PASSWORD });
const [b1, b2, b3, b4, b5] = await Promise.all([
  sb.from('budgets').select('amount_minor'), sb.from('debts').select('name'), sb.from('fixed_expenses').select('name'),
  sb.from('subscriptions').select('status'), sb.from('email_connections').select('status'),
]);
check('A sees only own budgets/debts/fixed', (b1.data ?? []).length === 1 && (b2.data ?? []).every((d) => d.name === 'E2E Préstamo') && (b3.data ?? []).length === 1,
  JSON.stringify([b1.data, b2.data, b3.data]));
check('A sees only own subscription (trialing) and own addresses', JSON.stringify(b4.data) === '[{"status":"trialing"}]' && (b5.data ?? []).length === 2, JSON.stringify([b4.data, b5.data]));
const up = await sb.from('subscriptions').update({ status: 'active' }).neq('status', 'x').select('status');
check('client cannot upgrade itself to paid Plus', !!up.error || (up.data ?? []).length === 0, JSON.stringify(up));
const addr = await sb.from('email_connections').insert({ address_local: 'f_aaaaaaaaaaaaaaaaaaaaaaaa', user_id: (await sb.auth.getUser()).data.user?.id });
check('client cannot choose its forwarding address', !!addr.error, JSON.stringify(addr.error));
const del = await sb.from('inbound_deliveries').select('id');
check('deliveries ledger invisible', !!del.error, JSON.stringify(del));
await sb.auth.signOut();

for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  [${d.slice(0, 220)}]`}`);
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
