/**
 * TASK-009 (UI) + TASK-010 + TASK-011 + TASK-012 end-to-end against the REAL Supabase project.
 * Seed: A has a confirmed Alimentación expense of S/ 400.00 this month; B has a budget, a debt and a subscription.
 * The app runs WITHOUT INBOUND_EMAIL_SECRET/DATABASE_URL (webhook must answer 503).
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { BASE, act, apiAs, changed, login, probe, runSuite } from './lib.ts';

const A = probe('s9a');

await runSuite('planning-account', async ({ page, check }) => {
  const limaToday = new Date(Date.now() - 5 * 3600_000);
  // A due day within the next 3 days that the form accepts (1–28): tomorrow, else today, else the 1st (month end).
  const d0 = limaToday.getUTCDate();
  const dueTomorrow = String(d0 + 1 <= 28 ? d0 + 1 : d0 <= 28 ? d0 : 1);

  const webhook = await page.request.post(`${BASE}/api/inbound/email`, { data: { deliveryId: 'x', to: 'f_x@x.pe' } });
  check('webhook disabled without server secrets (503)', webhook.status() === 503, String(webhook.status()));

  await login(page, A);

  // ── Budgets ──────────────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/presupuestos`);
  const bf = 'form[aria-label="Guardar presupuesto"]';
  check('no budgets yet: short empty state with one action', ((await page.locator('main').textContent()) ?? '').includes('Aún no hay presupuestos'));
  await page.getByRole('button', { name: 'Nuevo presupuesto' }).click();
  await page.selectOption(`${bf} select[name=categoryId]`, { label: 'Alimentación' });
  await page.fill(`${bf} input[name=amount]`, '350');
  await act(page, () => page.click(`${bf} button[type=submit]`));
  const blist = (await page.getByTestId('budget-list').textContent()) ?? '';
  check('budget shows spent, limit, remaining and state in words', blist.includes('S/ 400.00 de S/ 350.00') && blist.includes('Te pasaste por S/ 50.00') && blist.includes('Te pasaste'), blist);
  await page.goto(`${BASE}/app`);
  check('dashboard alert: budget exceeded', ((await page.locator('[data-alert="budget_exceeded:Alimentación"]').textContent()) ?? '').includes('Presupuesto excedido'));

  // ── Commitments ─────────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/compromisos`);
  check('Free: recurring detection offered as Plus, nothing computed', ((await page.getByTestId('recurring').textContent()) ?? '').includes('En Plus: detectamos los cobros')
    && (await page.getByTestId('recurring-list').count()) === 0);
  await page.getByRole('button', { name: 'Agregar pago' }).first().click();
  const ff = 'form[aria-label="Agregar pago"]';
  await page.fill(`${ff} input[name=name]`, 'E2E Alquiler');
  await page.fill(`${ff} input[name=amount]`, '1500');
  await page.fill(`${ff} input[name=dueDay]`, '5');
  await act(page, () => page.click(`${ff} button[type=submit]`));
  await page.click('text=Agregar deuda');
  const df = 'form[aria-label="Agregar deuda"]';
  await page.fill(`${df} input[name=name]`, 'E2E Préstamo');
  await page.fill(`${df} input[name=principal]`, '30000');
  await page.fill(`${df} input[name=balance]`, '18000');
  await page.fill(`${df} input[name=installment]`, '1000');
  await page.click(`${df} summary`);
  await page.fill(`${df} input[name=installmentsTotal]`, '36');
  await page.fill(`${df} input[name=installmentsPaid]`, '12');
  await page.fill(`${df} input[name=dueDay]`, dueTomorrow);
  const totalBefore = (await page.getByTestId('commitment-total').textContent()) ?? '';
  await page.click(`${df} button[type=submit]`);
  await changed(page, 'commitment-total', totalBefore);
  check('commitment total = rent + installment', ((await page.getByTestId('commitment-total').textContent()) ?? '').includes('S/ 2,500.00'),
    (await page.getByTestId('commitment-total').textContent()) ?? '');
  const debtBefore = (await page.getByTestId('debt').textContent()) ?? '';
  await page.getByRole('button', { name: 'Registrar pago de E2E Préstamo' }).click();
  await page.fill('form[aria-label="Pago E2E Préstamo"] input[name=amount]', '1000');
  await page.click('form[aria-label="Pago E2E Préstamo"] button[type=submit]');
  await changed(page, 'debt', debtBefore);
  const debt = (await page.getByTestId('debt').textContent()) ?? '';
  check('debt payment updates balance and installments only', debt.includes('Saldo S/ 17,000.00') && debt.includes('cuota 13/36') && debt.includes('Pagado S/ 13,000.00'), debt);
  await page.goto(`${BASE}/app`);
  check('dashboard commitments card', ((await page.getByTestId('commitments').textContent()) ?? '').includes('2 pagos'));
  check('dashboard alert: debt due soon', (await page.locator('[data-alert^="debt_due:"]').count()) === 1);
  check('commitments never change expenses (still S/ 400.00)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 400.00', (await page.getByTestId('expenses-PEN').textContent()) ?? '');

  // ── Account / plan ──────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/ajustes/plan`);
  check('Free plan with limits shown', (await page.getByTestId('plan-name').textContent()) === 'Free' && (await page.getByTestId('auto-usage').textContent()) === '0 de 50');
  await act(page, () => page.getByTestId('upgrade').click());
  await page.reload();
  check('trial active with exact end date', (await page.getByTestId('plan-name').textContent()) === 'Plus · prueba' && (await page.getByTestId('trial-end').count()) === 1);
  check('trial cannot be offered again', (await page.getByTestId('upgrade').count()) === 0);

  // ── Recurring detection (Plus, TASK-016): 3 monthly NETFLIX E2E charges in the seed ──────────────────
  await page.goto(`${BASE}/app/compromisos`);
  const rec = (await page.getByTestId('recurring-list').textContent()) ?? '';
  check('Plus: monthly charge detected with typical amount and day', rec.includes('NETFLIX E2E') && rec.includes('S/ 44.90') && rec.includes('día 5'), rec);
  check('one-off merchant is not suggested', !rec.includes('MERCADO E2E'), rec);
  await act(page, () => page.click('form[aria-label="Agregar NETFLIX E2E como gasto fijo"] button'));
  await page.reload();
  check('accepted suggestion becomes a fixed expense and is marked tracked',
    ((await page.getByTestId('recurring-list').textContent()) ?? '').includes('Ya es gasto fijo'));

  // ── Connections ─────────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/conexiones`);
  check('bridge honestly marked unavailable', ((await page.getByTestId('bridge-status').textContent()) ?? '').includes('Aún no disponible'));
  await act(page, () => page.click('form[aria-label="Generar dirección"] button'));
  const a1 = (await page.getByTestId('bridge-address').textContent()) ?? '';
  await page.click('form[aria-label="Generar dirección"] button');
  await changed(page, 'bridge-address', a1);
  const a2 = (await page.getByTestId('bridge-address').textContent()) ?? '';
  check('private address generated (120-bit) and rotated', /f_[a-z2-7]{24}@/.test(a1) && /f_[a-z2-7]{24}@/.test(a2) && a1 !== a2, `${a1} | ${a2}`);

  // ── A/B and client write attempts through the API ───────────────────────────────────────────────────
  const sb = await apiAs(A);
  const [b1, b2, b3, b4, b5] = await Promise.all([
    sb.from('budgets').select('amount_minor'), sb.from('debts').select('name'), sb.from('fixed_expenses').select('name'),
    sb.from('subscriptions').select('status'), sb.from('email_connections').select('status'),
  ]);
  check('A sees only own budgets/debts/fixed', (b1.data ?? []).length === 1 && (b2.data ?? []).every((d) => d.name === 'E2E Préstamo') && (b3.data ?? []).length === 2,
    JSON.stringify([b1.data, b2.data, b3.data]));
  check('A sees only own subscription (trialing) and own addresses', JSON.stringify(b4.data) === '[{"status":"trialing"}]' && (b5.data ?? []).length === 2, JSON.stringify([b4.data, b5.data]));
  const up = await sb.from('subscriptions').update({ status: 'active' }).neq('status', 'x').select('status');
  check('client cannot upgrade itself to paid Plus', !!up.error || (up.data ?? []).length === 0, JSON.stringify(up));
  const addr = await sb.from('email_connections').insert({ address_local: 'f_aaaaaaaaaaaaaaaaaaaaaaaa', user_id: (await sb.auth.getUser()).data.user?.id });
  check('client cannot choose its forwarding address', !!addr.error, JSON.stringify(addr.error));
  const del = await sb.from('inbound_deliveries').select('id');
  check('deliveries ledger invisible', !!del.error, JSON.stringify(del));
  await sb.auth.signOut();
});
