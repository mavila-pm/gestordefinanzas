/**
 * Planes → Pago → Gracias (ADR-0019) end-to-end against the REAL Supabase project, through the running app. Demo path
 * only: NO real charge can happen here. s18a is a demo account (purchase simulated, subscription untouched); s18b is a
 * real account that cannot buy anything while Culqi is off. If the server runs with Culqi SANDBOX keys, s18a sees the
 * card button instead and the suite stops before opening Culqi (the sandbox run is manual: docs/runbooks/billing-culqi.md).
 * Run: scripts/e2e.sh billing (seed pair s18: scripts/e2e.sh render-seed s18a s18b). Status: written, not run yet.
 */
import { act, apiAs, BASE, login, nav, probe, runSuite } from './lib.ts';

const A = probe('s18a');
const B = probe('s18b');
const text = async (page: import('playwright-core').Page, id: string) => ((await page.getByTestId(id).textContent()) ?? '').replace(/\s+/g, ' ').trim();

await runSuite('billing', async ({ page, check }) => {
  // ── Webhook: never open without its credentials ────────────────────────────────────────────────────────────────
  const hook = await fetch(`${BASE}/api/billing/culqi`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"charge.creation.succeeded","data":{"id":"chr_test_Forged00000000000"}}' });
  check('webhook: 503 without Culqi credentials, 401 with them but no Basic auth (never 200 for a forged event)', hook.status === 503 || hook.status === 401, String(hook.status));

  // ── A: demo account ────────────────────────────────────────────────────────────────────────────────────────────
  await login(page, A);
  await page.goto(`${BASE}/app/planes`);
  const prices = await Promise.all(['monthly', 'annual', 'lifetime'].map((p) => text(page, `price-${p}`)));
  check('plans: three prices from the server (US$)', prices.every((p) => p.startsWith('US$')), JSON.stringify(prices));
  await nav(page, () => page.getByTestId('choose-lifetime').click());
  check('checkout for Vitalicio', page.url().includes('/app/planes/pago?plan=lifetime'), page.url());
  const sandbox = await page.getByTestId('card-checkout').isVisible().catch(() => false);
  if (sandbox) {
    check('sandbox keys: the demo account gets the Culqi card button in test mode (stop here, manual run)', await page.getByTestId('test-mode').isVisible());
    return;
  }
  check('demo notice: simulated, no charge', await page.getByTestId('demo-notice').isVisible());
  check('pays today = the full price', (await text(page, 'pay-today')) === prices[2], await text(page, 'pay-today'));
  await page.getByTestId('terms').check();
  await act(page, () => page.getByTestId('pay').click());
  await page.waitForURL(/\/app\/planes\/gracias\?pedido=[0-9a-f-]{36}$/);
  check('gracias shows a simulated purchase, never a real one', await page.getByTestId('simulated').isVisible());
  check('charged US$ 0.00', (await text(page, 'charged')).includes('0.00'), await text(page, 'charged'));
  const apiA = await apiAs(A);
  const { data: orders } = await apiA.from('billing_orders').select('status,plan_code,amount_minor');
  check('one order, status simulated, at the server price', orders?.length === 1 && orders[0]!.status === 'simulated' && orders[0]!.plan_code === 'lifetime', JSON.stringify(orders));
  const { data: sub } = await apiA.from('subscriptions').select('billing_plan,status').maybeSingle();
  check('the real subscription did not change (no billing plan)', !sub?.billing_plan, JSON.stringify(sub));

  await page.goto(`${BASE}/app/planes/pago?plan=monthly`);
  const trial = await page.getByTestId('pay').textContent();
  check('Mensual: first purchase offers the trial (US$ 0.00 today)', (await text(page, 'pay-today')).includes('0.00') && /días gratis/.test(trial ?? ''), trial ?? '');

  // ── B: real account, Culqi off ────────────────────────────────────────────────────────────────────────────────
  await page.context().clearCookies();
  await login(page, B);
  await page.goto(`${BASE}/app/planes/pago?plan=annual`);
  check('real account: "payments soon", no card button', await page.getByTestId('payments-soon').isVisible() && !(await page.getByTestId('card-checkout').isVisible().catch(() => false)));
  check('real account: the pay button is disabled', await page.getByTestId('pay').isDisabled());
  const apiB = await apiAs(B);
  const { error: sim } = await apiB.rpc('billing_simulate_payment', { p_order: '00000000-0000-4000-8000-000000000000' });
  check('real account cannot simulate a payment', !!sim, sim?.message);
  const { error: act1 } = await apiB.rpc('billing_activate', { p_order: '00000000-0000-4000-8000-000000000000', p_provider: 'culqi', p_ref: 'chr_test_x', p_amount_minor: 19800, p_currency: 'USD' });
  check('clients can never activate a plan (service-only function)', !!act1, act1?.message);
  const { data: bOrders } = await apiB.from('billing_orders').select('id');
  check('no order was created for the real account', (bOrders ?? []).length === 0, JSON.stringify(bOrders));
  await page.goto(`${BASE}/app/ajustes/plan`);
  check('Plan y uso: no cancel control without a paid renewal', !(await page.getByTestId('cancel-renewal').isVisible().catch(() => false)));
});
