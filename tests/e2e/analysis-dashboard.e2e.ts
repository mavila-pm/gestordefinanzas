/**
 * TASK-007 + TASK-008 end-to-end against the REAL Supabase project, through the running app.
 * Seed (docs/runbooks/e2e.md): A has 4 months of confirmed data ending in the current Lima month (M0; its rows are
 * clamped to today), one pending, one USD, an unusual expense and a merchant '=HYPERLINK(...)'; B has "E2E SECRET B".
 * Month labels below are computed (M0 = this month, M1 = the previous one), so the suite runs on any date.
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { act, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s78a');
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const lima = new Date(Date.now() - 5 * 3600_000);
const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, '0')}`;
const M0 = ym(lima.getUTCFullYear(), lima.getUTCMonth());
const prev = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth() - 1, 1));
const M1 = ym(prev.getUTCFullYear(), prev.getUTCMonth());
const M1_NAME = MONTHS[prev.getUTCMonth()]!;
const old = new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth() - 3, 1));
const M3 = ym(old.getUTCFullYear(), old.getUTCMonth());

await runSuite('analysis-dashboard', async ({ browser, page, check }) => {
  await login(page, A);
  const anon = await browser.newContext();
  const exportAnon = await anon.request.get(`${BASE}/app/exportar?month=${M0}`, { maxRedirects: 0 });
  check('export without session is refused (redirect to login)', exportAnon.status() === 307 || exportAnon.status() === 401, String(exportAnon.status()));


  // Settings: display name used by milestones.
  await page.goto(`${BASE}/app/ajustes`);
  check('no name yet: neutral profile summary (never the email)', ((await page.getByTestId('profile-name').textContent()) ?? '') === 'Aún no nos dijiste tu nombre');
  await page.getByRole('button', { name: 'Editar perfil' }).click();
  await page.fill('input[name=givenNames]', 'Mauro Antonio');
  await page.fill('input[name=familyNames]', 'Ávila Pérez');
  check('preferred name pre-filled with the first given name', (await page.inputValue('input[name=displayName]')) === 'Mauro');
  await act(page, () => page.click('form[aria-label="Perfil"] button[type=submit]'));
  await page.reload();
  check('profile shows "Mauro Ávila"; full names kept', ((await page.getByTestId('profile-name').textContent()) ?? '') === 'Mauro Ávila'
    && (await page.inputValue('input[name=givenNames]')) === 'Mauro Antonio' && (await page.inputValue('input[name=familyNames]')) === 'Ávila Pérez');

  // ── Dashboard (TASK-008) ───────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app`);
  const milestone = (await page.getByTestId('milestone').textContent().catch(() => null)) ?? '';
  check('milestone for the closed month (consistency, with name)', milestone === `Llevas tres meses consecutivos cerrando con saldo positivo, Mauro. En ${M1_NAME} ahorraste S/ 1,000.00.`, milestone);
  check('dashboard greets by the preferred name only', ((await page.locator('main h1').first().textContent()) ?? '') === 'Hola, Mauro.');
  check('pending review shown as one line with the count', ((await page.getByTestId('review-alert').textContent()) ?? '').includes('1 movimiento por revisar'));
  check('figures marked estimated while something waits', ((await page.getByTestId('data-health').textContent()) ?? '').includes('Estimado'));
  const alerts = await page.locator('[data-testid=alerts] li').evaluateAll((els) => els.map((e) => e.getAttribute('data-alert')));
  check('alerts: unusual expense (card payment/ATM never unusual); pending has its own line', JSON.stringify(alerts) === JSON.stringify(['unusual_expense']), JSON.stringify(alerts));
  check('unusual expense names the merchant', ((await page.locator('[data-alert=unusual_expense]').textContent()) ?? '').includes('S/ 3,000.00 en TIENDA RARA E2E'));
  check('M0 expenses exclude card payment and ATM: S/ 4,220.00', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 4,220.00', (await page.getByTestId('expenses-PEN').textContent()) ?? '');
  await page.goto(`${BASE}/app?month=${M1}`);
  check('no milestone when viewing a past month', (await page.getByTestId('milestone').count()) === 0);
  check('month navigation shows M1 figures', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 4,000.00');

  // ── Free history window (§81): A is on Free; M3 ('GASTOS JUNIO') is kept but not shown ──
  await page.goto(`${BASE}/app?month=${M3}`);
  check('Free: a month older than the window shows the first visible one (M2: S/ 4,000.00)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 4,000.00' && (await page.getByLabel('Mes anterior').count()) === 0);
  await page.goto(`${BASE}/app/movimientos?month=all&q=GASTOS`);
  check('Free: list stops at the window (GASTOS JULIO yes, GASTOS JUNIO no) and says so', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('1 movimiento') && (await page.getByTestId('history-window').count()) === 1, (await page.getByTestId('movement-count').textContent()) ?? '');
  const csvAll = await (await page.request.get(`${BASE}/app/exportar?month=all&q=GASTOS`)).text();
  check('Free: export keeps the full history (data access is never premium)', csvAll.includes('GASTOS JUNIO'));

  // ── Movements (TASK-007) ───────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/movimientos?month=${M0}`);
  check('M0: 9 movements for A (B invisible)', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('9 movimiento'), (await page.getByTestId('movement-count').textContent()) ?? '');
  check('B never listed', !((await page.getByTestId('movement-list').textContent()) ?? '').includes('SECRET B'));
  await page.goto(`${BASE}/app/movimientos?month=${M0}&kind=expense&currency=PEN&status=confirmed`);
  check('filter: confirmed PEN expenses = 4', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('4 movimiento'), (await page.getByTestId('movement-count').textContent()) ?? '');
  await page.goto(`${BASE}/app/movimientos?month=all&q=restaurante`);
  check('search is case-insensitive across months: 2 RESTAURANTE', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('2 movimiento'), (await page.getByTestId('movement-count').textContent()) ?? '');
  await page.goto(`${BASE}/app/movimientos?month=all&status=pending`);
  check('filter: pending = 1', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('1 movimiento'));
  await page.goto(`${BASE}/app/movimientos?month=${M0}&q=${encodeURIComponent('S/ 400.00')}`);
  const byAmount = (await page.getByTestId('movement-list').textContent()) ?? '';
  check('search by amount finds the S/ 400.00 movement (UBER E2E) and nothing else', byAmount.includes('UBER E2E') && ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('1 movimiento'), byAmount);
  await page.goto(`${BASE}/app/movimientos?month=all&q=${encodeURIComponent('1,0),amount_minor.gt.0')}`);
  check('amount search cannot inject extra filters', (await page.getByTestId('movement-count').count()) === 1 && (await page.locator('[role=alert]:not(#__next-route-announcer__)').count()) === 0);
  await page.goto(`${BASE}/app/movimientos?month=all&q=%25%27%29%28*`);
  check('hostile search is neutralized (no error)', (await page.getByTestId('movement-count').count()) === 1 && (await page.locator('[role=alert]:not(#__next-route-announcer__)').count()) === 0);
  await page.goto(`${BASE}/app/movimientos?month=all&source=import`);
  check('filter by source: no imports', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('0 movimiento'));

  // ── Export ─────────────────────────────────────────────────────────────────────────────────────────────
  const res = await page.request.get(`${BASE}/app/exportar?month=${M0}`);
  const csv = await res.text();
  check('CSV served as attachment', res.status() === 200 && (res.headers()['content-disposition'] ?? '').includes(`movimientos-${M0}.csv`));
  check('CSV has 9 rows + header', csv.trim().split('\r\n').length === 10, String(csv.trim().split('\r\n').length));
  check('CSV neutralizes formula injection', csv.includes(`"'=HYPERLINK(""http://evil"")"`) && !csv.includes(';"=HYPERLINK'));
  check('CSV exact decimals and effect', csv.includes('"Retiro de efectivo";"Retiro de efectivo";"200.00";"PEN"') && csv.includes('"810.00"'));
  check('CSV never includes B', !csv.includes('SECRET B'));

  // ── Analysis ───────────────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/app/analisis?month=${M0}`);
  check('analysis expenses S/ 4,220.00', (await page.getByTestId('an-expenses-PEN').textContent()) === 'S/ 4,220.00');
  const cats = (await page.getByTestId('categories-PEN').textContent()) ?? '';
  check('category deltas vs M1', cats.includes('Alimentación') && cats.includes('S/ 810.00') && cats.includes('S/ 500.00'), cats);
  const top = (await page.getByTestId('top-PEN').textContent()) ?? '';
  check('top merchant is TIENDA RARA E2E', top.startsWith('TIENDA RARA E2E'), top);
  check('USD analysed separately', (await page.getByTestId('analysis-USD').count()) === 1);
});
