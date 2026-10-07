/**
 * MVP P1 "Eliminar mi cuenta" against the REAL Supabase project, with synthetic probe users only (s15a deletes itself).
 * Seed: s15a and s15b each have one movement and one debt. Run: scripts/e2e.sh account-delete (seed: tests/e2e/seed.sql).
 */
import { ALERT, BASE, act, apiAs, login, probe, runSuite } from './lib.ts';

const A = probe('s15a');
const B = probe('s15b');

await runSuite('account-delete', async ({ page, check }) => {
  await login(page, A);
  await page.goto(`${BASE}/app/ajustes`);
  await page.getByRole('button', { name: 'Eliminar mi cuenta' }).click();
  const form = 'form[aria-label="Eliminar cuenta"]';
  await page.fill(`${form} input[name=confirm]`, 'eliminar');
  await act(page, () => page.click(`${form} button[type=submit]`));
  check('wrong confirmation is refused with a clear error', ((await page.locator(`${form} ${ALERT}`).textContent().catch(() => '')) ?? '').includes('Escribe ELIMINAR'));
  check('nothing deleted yet: still in the app', page.url().startsWith(`${BASE}/app/ajustes`), page.url());

  await page.fill(`${form} input[name=confirm]`, 'ELIMINAR');
  await page.click(`${form} button[type=submit]`);
  await page.waitForURL(`${BASE}/?cuenta=eliminada`, { timeout: 15000 }).catch(() => undefined);
  check('after deleting: home with a confirmation', (await page.getByTestId('account-deleted').count()) === 1, page.url());
  await page.goto(`${BASE}/app`);
  check('session is gone: /app redirects to login', page.url().startsWith(`${BASE}/login`), page.url());

  let signIn = 'ok';
  try { await apiAs(A); } catch (e) { signIn = (e as Error).message; }
  check('the deleted account cannot sign in again', signIn !== 'ok', signIn);

  const b = await apiAs(B);
  const bt = await b.from('transactions').select('merchant_raw');
  const bd = await b.from('debts').select('name');
  check('B keeps its own rows (movement + debt)', (bt.data ?? []).length === 1 && (bd.data ?? []).length === 1, JSON.stringify([bt.data, bd.data]));
});
