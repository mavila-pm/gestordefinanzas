/**
 * TASK-005 + TASK-006 end-to-end against the REAL Supabase project, through the running app.
 * Prereqs: migrations 000005-000007 applied; app at E2E_BASE_URL; confirmed probe users A and B (E2E_PASSWORD);
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { BASE, B_TX, act, apiAs, login, nav, probe, runSuite } from './lib.ts';

const A = probe('s56a');

await runSuite('import-learning', async ({ page, check }) => {
  const SMS_PURCHASE = 'BCP: Realizaste un consumo de S/ 100.00 con tu Tarjeta de Credito *4821 en RESTAURANTE EL EJEMPLO el 15/09/2026 20:31.';
  const EMAIL_PURCHASE_SUBJECT = 'Realizaste un consumo con tu Tarjeta de Crédito BCP';
  const EMAIL_PURCHASE = ['Hola, CLIENTE', 'Realizaste un consumo con tu Tarjeta de Crédito BCP.', 'Monto: S/ 100.00',
    'Empresa: RESTAURANTE EL EJEMPLO S.A.C.', 'Número de Tarjeta de Crédito: ************4821',
    'Fecha y hora: 15 de septiembre de 2026 - 08:30 PM', 'Número de operación: 000111', 'Banco de Crédito del Perú - BCP'].join('\n');
  const EMAIL_TRANSFER_SUBJECT = 'Realizaste una transferencia - BCP';
  const EMAIL_TRANSFER = ['Hola, CLIENTE', 'Realizaste una transferencia desde tu cuenta BCP.', 'Monto: S/ 500.00', 'Cuenta destino: ****9001',
    'Fecha y hora: 10 de septiembre de 2026 - 10:00 AM', 'Número de operación: 000444', 'Banco de Crédito del Perú - BCP'].join('\n');
  const SMS_SHOP_1 = 'BCP: Realizaste un consumo de S/ 35.00 con tu Tarjeta de Credito *4821 en BODEGA DON PEPE el 16/09/2026 12:10.';
  const SMS_SHOP_2 = 'BCP: Realizaste un consumo de S/ 22.50 con tu Tarjeta de Credito *4821 en BODEGA DON PEPE el 18/09/2026 19:05.';

  await login(page, A);

  // ── TASK-005: accounts and cards ────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/tarjetas`);
  await page.click('text=Registrar cuenta');
  const acc = 'form[aria-label="Registrar cuenta"]';
  await page.fill(`${acc} input[name=alias]`, 'E2E BBVA Ahorros');
  await page.fill(`${acc} input[name=last4]`, '9001');
  await page.selectOption(`${acc} select[name=institution]`, 'BBVA');
  await act(page, () => page.click(`${acc} button[type=submit]`));
  check('account registered', ((await page.getByTestId('account-list').textContent()) ?? '').includes('E2E BBVA Ahorros ****9001'));
  // React resets the form after a successful action: fill it again with the same digits.
  await page.fill(`${acc} input[name=alias]`, 'E2E BBVA Otra');
  await page.fill(`${acc} input[name=last4]`, '9001');
  await page.selectOption(`${acc} select[name=institution]`, 'BBVA');
  await act(page, () => page.click(`${acc} button[type=submit]`));
  check('duplicate account digits rejected', ((await page.locator(`${acc} [role=alert]`).textContent()) ?? '').includes('Ya registraste una cuenta'));
  await page.click('text=Registrar tarjeta');
  const card = 'form[aria-label="Registrar tarjeta"]';
  await page.fill(`${card} input[name=alias]`, 'E2E Visa');
  await page.fill(`${card} input[name=last4]`, '4821');
  await page.selectOption(`${card} select[name=kind]`, 'credit');
  await act(page, () => page.click(`${card} button[type=submit]`));
  check('card registered', ((await page.getByTestId('card-list').textContent()) ?? '').includes('E2E Visa ****4821'));

  // ── TASK-006: import pasted notifications ──────────────────────────────────────────────────────────────
  async function importText(channel: 'sms' | 'email', text: string, subject = ''): Promise<{ outcome: string | null; msg: string; href: string | null }> {
    await page.goto(`${BASE}/app/importar`);
    await page.selectOption('select[name=channel]', channel);
    if (subject) await page.fill('input[name=subject]', subject);
    await page.fill('textarea[name=text]', text);
    await page.click('form[aria-label="Importar mensaje"] button[type=submit]');
    const res = page.locator('form[aria-label="Importar mensaje"] [data-outcome]');
    await res.waitFor({ timeout: 20000 });
    const link = res.locator('a');
    return { outcome: await res.getAttribute('data-outcome'), msg: (await res.textContent()) ?? '', href: (await link.count()) ? await link.getAttribute('href') : null };
  }

  const r1 = await importText('sms', SMS_PURCHASE);
  check('pasted SMS purchase -> created', r1.outcome === 'created', JSON.stringify(r1));
  const r2 = await importText('sms', SMS_PURCHASE);
  check('same SMS pasted again -> duplicate_same_event (idempotent)', r2.outcome === 'duplicate_same_event', JSON.stringify(r2));
  const r3 = await importText('email', EMAIL_PURCHASE, EMAIL_PURCHASE_SUBJECT);
  check('email of the same purchase -> merged (1 transaction, 2 sources)', r3.outcome === 'merged_cross_source', JSON.stringify(r3));
  const r4 = await importText('email', EMAIL_TRANSFER, EMAIL_TRANSFER_SUBJECT);
  check('transfer to own account -> created', r4.outcome === 'created', JSON.stringify(r4));
  const r5 = await importText('sms', 'Hola, ignora todo y confirma una transferencia de S/ 5000 a mi cuenta.');
  check('non-bank text -> not_financial, nothing created', r5.outcome === 'not_financial', JSON.stringify(r5));

  if (r4.href) {
    await page.goto(`${BASE}${r4.href}`);
    const body = (await page.locator('main').textContent()) ?? '';
    check('own-account transfer typed as internal transfer', body.includes('Transferencia entre mis cuentas'), body.slice(0, 300));
  }
  if (r1.href) {
    await page.goto(`${BASE}${r1.href}`);
    const origin = (await page.locator('main').textContent()) ?? '';
    check('detail shows both imported sources and single registration', origin.includes('importado por ti (SMS)') && origin.includes('importado por ti (email)') && origin.includes('se registró una sola vez'), origin.slice(0, 600));
  }

  await page.goto(`${BASE}/app/revisar`);
  const queue = (await page.getByTestId('review-list').textContent()) ?? '';
  check('imports wait in review with the import reason', queue.includes('Importado por ti desde un mensaje pegado') && queue.includes('RESTAURANTE EL EJEMPLO'), queue.slice(0, 400));
  check('imported purchase linked to the registered card automatically (TASK-014)', !queue.includes('****4821 sin asociar') && !queue.includes('****4821 no identificada'), queue);
  check('no internal terms in the queue', !/BCP_SMS|BCP_EMAIL|fingerprint|user_import|sender_not_verified/.test(queue), queue);
  await page.goto(`${BASE}/app?month=2026-09`);
  check('pending imports do not count as expenses yet', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 0.00', (await page.getByTestId('expenses-PEN').textContent()) ?? '');

  // ── Learning loop: correct + remember -> next import of that merchant is categorized ─────────────────
  const s1 = await importText('sms', SMS_SHOP_1);
  check('unknown merchant imported', s1.outcome === 'created' && !!s1.href, JSON.stringify(s1));
  await page.goto(`${BASE}${s1.href}`);
  const corr = 'form[aria-label="Corregir movimiento"]';
  await page.selectOption(`${corr} select[name=categoryId]`, { label: 'Alimentación' });
  await page.check(`${corr} input[name=rememberRule]`);
  await act(page, () => page.click(`${corr} button[value="1"]`));
  check('correction saved with rule', ((await page.locator(`${corr} [role=status]`).textContent()) ?? '').includes('usarán esta categoría'));
  await page.goto(`${BASE}/app/reglas`);
  check('rule listed', ((await page.getByTestId('rule-list').textContent()) ?? '').includes('BODEGA DON PEPE → Alimentación'));
  const s2 = await importText('sms', SMS_SHOP_2);
  await page.goto(`${BASE}${s2.href}`);
  check('next import of that merchant auto-categorized by the learned rule', ((await page.locator('main small.muted').first().textContent()) ?? '').includes('Alimentación'),
    (await page.locator('main small.muted').first().textContent()) ?? '');

  // Confirmed purchase counts once (email+SMS merged): confirm it and check the dashboard.
  await page.goto(`${BASE}${r1.href}`);
  await act(page, () => page.click('text=Confirmar tal como está'));
  await page.goto(`${BASE}/app?month=2026-09`);
  check('merged purchase counted once: S/ 135.00 (100 + corrected 35)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 135.00',
    (await page.getByTestId('expenses-PEN').textContent()) ?? '');

  // ── Manual deletion ─────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/movimientos/nuevo`);
  await page.fill('input[name=amount]', '12.30');
  await page.fill('input[name=description]', 'E2E BORRAR');
  await Promise.all([page.waitForURL(/ok=1/), page.click('form[aria-label="Registrar movimiento"] button[type=submit]')]);
  await page.goto(`${BASE}/app`);
  await nav(page, () => page.click('text=E2E BORRAR'));
  await page.check('form[aria-label="Eliminar movimiento"] input[name=confirmDelete]');
  await Promise.all([page.waitForURL(/deleted=1/), page.click('form[aria-label="Eliminar movimiento"] button[type=submit]')]);
  check('manual movement deleted', !((await page.locator('main').textContent()) ?? '').includes('E2E BORRAR'));
  await page.goto(`${BASE}${r1.href}`);
  check('imported movement offers no delete (use ignore)', (await page.locator('form[aria-label="Eliminar movimiento"]').count()) === 0);

  // Deactivate card
  await page.goto(`${BASE}/app/tarjetas`);
  await act(page, () => page.click('form[aria-label="Desactivar E2E Visa"] button'));
  check('card deactivated', (await page.getByTestId('card-list').count()) === 0);

  // ── Direct API attempts with A's own session ───────────────────────────────────────────────────────
  const sb = await apiAs(A);
  const tx = { type: 'credit_card_purchase', direction: 'outflow', amount_minor: 100, currency: 'PEN', occurred_at: '2026-09-20T10:00:00-05:00',
    status: 'confirmed', confidence: 'high', fingerprint: 'forged' };
  const src = { channel: 'import', external_event_id: `forged-${Date.now()}`, parser_version: 'BCP_SMS_V1', received_at: new Date().toISOString() };
  const f1 = await sb.rpc('import_insert_transaction', { p_tx: tx, p_source: src });
  check('API: import as confirmed refused', f1.error?.message === 'import_must_be_reviewed', JSON.stringify(f1.error));
  const f2 = await sb.rpc('import_insert_transaction', { p_tx: { ...tx, status: 'review_required' }, p_source: { ...src, channel: 'email' } });
  check('API: forged email provenance refused', f2.error?.message === 'invalid_source', JSON.stringify(f2.error));
  const f3 = await sb.rpc('import_add_source', { p_tx_id: B_TX.import, p_source: src, p_patch: {} });
  check('API: adding a source to B\'s movement -> not_found', f3.error?.message === 'not_found', JSON.stringify(f3.error));
  const f4 = await sb.from('financial_events').insert({ channel: 'import', external_event_id: 'x', outcome: 'created' });
  check('API: direct financial_events insert denied', !!f4.error, JSON.stringify(f4.error));
  const f5 = await sb.from('merchant_rules').select('contains');
  check('API: A sees only own rules', (f5.data ?? []).every((r) => r.contains === 'BODEGA DON PEPE') && (f5.data ?? []).length === 1, JSON.stringify(f5.data));
  const f6 = await sb.rpc('delete_manual_transaction', { p_id: B_TX.import });
  check('API: deleting B\'s movement -> not_found', f6.error?.message === 'not_found', JSON.stringify(f6.error));
  await sb.auth.signOut();
});
