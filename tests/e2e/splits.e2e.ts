/**
 * TASK-020 "Dividir gasto" end-to-end against the REAL Supabase project, through the running app.
 * Seed (seed.sql, s10*): A has "RESTAURANTE SPLIT E2E" S/ 180.00 confirmed (Alimentación) and a pending S/ 50.00;
 * B has a confirmed movement with a fixed id (B_TX.split).
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { act, apiAs, B_TX, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s10a');

await runSuite('splits', async ({ page, check }) => {
  await login(page, A);
  await page.goto(`${BASE}/app?month=2026-09`);
  const expensesBefore = (await page.getByTestId('expenses-PEN').textContent()) ?? '';
  check('before: expenses S/ 180.00 (pending S/ 50 not counted)', expensesBefore === 'S/ 180.00', expensesBefore);

  await page.getByText('RESTAURANTE SPLIT E2E').first().click();
  await page.waitForURL(/\/app\/movimientos\/[0-9a-f-]{36}$/);
  const detailUrl = page.url();
  await page.getByRole('button', { name: 'Dividir gasto' }).click();
  const sheet = page.getByTestId('split-sheet');
  await sheet.waitFor({ state: 'visible' });
  check('sheet opens with the movement in context (S/ 180.00)', ((await sheet.textContent()) ?? '').includes('S/ 180.00'));
  const save = sheet.getByRole('button', { name: 'Guardar división' });
  check('save disabled until parts are complete, with a text reason (not only colour)', await save.isDisabled()
    && ((await sheet.getByTestId('split-hint').textContent()) ?? '').length > 0);

  const rows = sheet.getByTestId('split-row');
  await rows.nth(0).locator('select').selectOption({ label: 'Alimentación' });
  await rows.nth(0).locator('input[inputmode=decimal]').fill('80');
  await rows.nth(1).locator('select').selectOption({ label: 'Ocio' });
  await rows.nth(1).locator('input[inputmode=decimal]').fill('60');
  await rows.nth(1).locator('input.note').fill('Amigos');
  await sheet.getByRole('button', { name: 'Añadir parte' }).click();
  await rows.nth(2).locator('select').selectOption({ label: 'Personal' });
  await rows.nth(2).locator('input[inputmode=decimal]').fill('150');
  check('over-allocation shows "te pasaste" and blocks saving', await save.isDisabled()
    && ((await sheet.getByTestId('split-remaining').textContent()) ?? '') === 'S/ 110.00'
    && ((await sheet.getByTestId('split-hint').textContent()) ?? '').includes('suman más'));
  await rows.nth(2).locator('input[inputmode=decimal]').fill('40');
  check('live summary: asignado S/ 180.00, restante S/ 0.00', ((await sheet.getByTestId('split-allocated').textContent()) ?? '') === 'S/ 180.00'
    && ((await sheet.getByTestId('split-remaining').textContent()) ?? '') === 'S/ 0.00');
  await act(page, () => save.click());
  await sheet.waitFor({ state: 'hidden' });
  check('sheet closes on success and stays on the same movement', page.url() === detailUrl, page.url());
  const summary = (await page.getByTestId('split-summary').textContent()) ?? '';
  check('detail shows the three parts', summary.includes('Alimentación') && summary.includes('S/ 80.00') && summary.includes('Ocio · Amigos')
    && summary.includes('S/ 60.00') && summary.includes('S/ 40.00'), summary);

  await page.goto(`${BASE}/app?month=2026-09`);
  check('month total stays S/ 180.00 (no double counting)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 180.00',
    (await page.getByTestId('expenses-PEN').textContent()) ?? '');
  const cats = (await page.locator('section[aria-label="En qué se fue tu dinero"]').textContent()) ?? '';
  check('categories receive 80 / 60 / 40', cats.includes('AlimentaciónS/ 80.00') && cats.includes('OcioS/ 60.00') && cats.includes('PersonalS/ 40.00'), cats);

  const csv = await (await page.request.get(`${BASE}/app/exportar?month=2026-09`)).text();
  const line = csv.split('\r\n').find((l) => l.includes('RESTAURANTE SPLIT E2E')) ?? '';
  check('CSV: one row with the full amount and the parts', csv.split('\r\n').filter((l) => l.includes('RESTAURANTE SPLIT E2E')).length === 1
    && line.includes('"180.00"') && line.includes('Alimentación 80.00 | Ocio (Amigos) 60.00 | Personal 40.00'), line);

  // Pending movement: no split offered.
  await page.goto(`${BASE}/app/movimientos?month=all&q=PENDIENTE`);
  await page.getByText('PENDIENTE SPLIT E2E').first().click();
  await page.waitForURL(/\/app\/movimientos\/[0-9a-f-]{36}$/);
  check('pending movement: "Dividir gasto" not offered', (await page.getByRole('button', { name: 'Dividir gasto' }).count()) === 0);

  // Remove the division: totals by category return to the original.
  await page.goto(detailUrl);
  await page.getByRole('button', { name: 'Editar división' }).click();
  await act(page, () => page.getByTestId('split-sheet').getByRole('button', { name: 'Quitar división' }).click());
  await page.goto(`${BASE}/app?month=2026-09`);
  const catsAfter = (await page.locator('section[aria-label="En qué se fue tu dinero"]').textContent()) ?? '';
  check('removing the division restores Alimentación S/ 180.00', catsAfter.includes('AlimentaciónS/ 180.00') && !catsAfter.includes('Ocio'), catsAfter);

  // API attacks (anon key + A's session).
  const sb = await apiAs(A);
  const cat = (await sb.from('categories').select('id').eq('name', 'Ocio').single()).data?.id;
  const onB = await sb.rpc('set_transaction_split', { p_tx_id: B_TX.split, p_parts: [{ category_id: cat, amount_minor: 100 }] });
  check('API: A cannot split B\'s movement (not_found)', onB.error?.message === 'not_found', JSON.stringify(onB.error));
  const readB = await sb.from('transaction_allocations').select('id');
  check('API: A reads no allocations of others', !readB.error && (readB.data ?? []).length === 0, JSON.stringify(readB));
  const direct = await sb.from('transaction_allocations').insert({ transaction_id: B_TX.split, category_id: cat, amount_minor: 1, position: 0 });
  check('API: direct insert into allocations refused', !!direct.error, JSON.stringify(direct.error));
  const id = detailUrl.split('/').pop()!;
  const over = await sb.rpc('set_transaction_split', { p_tx_id: id, p_parts: [{ category_id: cat, amount_minor: 18001 }] });
  check('API: over-allocation refused by the database', over.error?.message === 'over_allocated', JSON.stringify(over.error));
  const usd = await sb.rpc('set_transaction_split', { p_tx_id: id, p_parts: [{ category_id: cat, amount_minor: 100, currency: 'USD' }] });
  check('API: currency mismatch refused', usd.error?.message === 'currency_mismatch', JSON.stringify(usd.error));
  const stale = await sb.rpc('set_transaction_split', { p_tx_id: id, p_parts: [{ category_id: cat, amount_minor: 100 }], p_expected_updated_at: '2020-01-01T00:00:00Z' });
  check('API: concurrent edit with an old version refused (stale)', stale.error?.message === 'stale', JSON.stringify(stale.error));
});
