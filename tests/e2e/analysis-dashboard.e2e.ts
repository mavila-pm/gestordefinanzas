/**
 * TASK-007 + TASK-008 end-to-end against the REAL Supabase project, through the running app.
 * Seed (docs/runbooks/e2e.md): A has Jun-Sep 2026 confirmed data, one pending, one USD, an unusual expense on
 * 2026-09-25 and a merchant '=HYPERLINK(...)'; B has "E2E SECRET B". Assumes the Lima date is 2026-09-27..30.
 * Run: node --experimental-strip-types tests/e2e/analysis-dashboard.e2e.ts
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const A = process.env.E2E_A_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
if (!A || !PASSWORD) throw new Error('missing E2E env');

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push([name, ok, detail]); };
function chromiumPath(): string | undefined {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const p = dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
  return p && existsSync(p) ? p : undefined;
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
const anon = await browser.newContext();
const exportAnon = await anon.request.get(`${BASE}/app/exportar?month=2026-09`, { maxRedirects: 0 });
check('export without session is refused (redirect to login)', exportAnon.status() === 307 || exportAnon.status() === 401, String(exportAnon.status()));

const page = await browser.newPage();
await page.goto(`${BASE}/login`);
await page.fill('input[name=email]', A);
await page.fill('input[name=password]', PASSWORD);
await Promise.all([page.waitForURL(/\/app/), page.click('button[type=submit]')]);

// Settings: display name used by milestones.
await page.goto(`${BASE}/app/ajustes`);
await page.fill('input[name=displayName]', 'Mauro E2E');
await page.click('form[aria-label="Perfil"] button[type=submit]');
await page.locator('form[aria-label="Perfil"] [role=status]').waitFor();

// ── Dashboard (TASK-008) ───────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app`);
const milestone = (await page.getByTestId('milestone').textContent().catch(() => null)) ?? '';
check('milestone for the closed month (consistency, with name)', milestone === 'Llevas tres meses consecutivos cerrando con saldo positivo, Mauro. En agosto ahorraste S/ 1,000.00.', milestone);
const health = (await page.getByTestId('data-health').textContent()) ?? '';
check('data health PARTIAL with reasons (pending + no automatic source)', health.includes('Datos parciales') && health.includes('1 movimiento(s) por revisar') && health.includes('fuentes automáticas'), health);
const alerts = await page.locator('[data-testid=alerts] li').evaluateAll((els) => els.map((e) => e.getAttribute('data-alert')));
check('alerts: pending + unusual expense (card payment/ATM never unusual)', JSON.stringify(alerts) === JSON.stringify(['pending', 'unusual_expense']), JSON.stringify(alerts));
check('unusual expense names the merchant', ((await page.locator('[data-alert=unusual_expense]').textContent()) ?? '').includes('S/ 3,000.00 en TIENDA RARA E2E'));
const insight = (await page.getByTestId('insight').textContent()) ?? '';
check('main insight explains the increase (estimated: 1 pending)', insight.startsWith('Estimado: Alimentación aumentó S/ 310.00'), insight);
check('September expenses exclude card payment and ATM: S/ 4,220.00', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 4,220.00', (await page.getByTestId('expenses-PEN').textContent()) ?? '');
check('savings labelled estimated while pending', (await page.content()).includes('Ahorro estimado'));
await page.goto(`${BASE}/app?month=2026-08`);
check('no milestone when viewing a past month', (await page.getByTestId('milestone').count()) === 0);
check('month navigation shows August figures', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 4,000.00');

// ── Movements (TASK-007) ───────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app/movimientos?month=2026-09`);
check('September: 9 movements for A (B invisible)', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('9 movimiento'), (await page.getByTestId('movement-count').textContent()) ?? '');
check('B never listed', !((await page.getByTestId('movement-list').textContent()) ?? '').includes('SECRET B'));
await page.goto(`${BASE}/app/movimientos?month=2026-09&kind=expense&currency=PEN&status=confirmed`);
check('filter: confirmed PEN expenses = 4', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('4 movimiento'), (await page.getByTestId('movement-count').textContent()) ?? '');
await page.goto(`${BASE}/app/movimientos?month=all&q=restaurante`);
check('search is case-insensitive across months: 2 RESTAURANTE', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('2 movimiento'), (await page.getByTestId('movement-count').textContent()) ?? '');
await page.goto(`${BASE}/app/movimientos?month=all&status=pending`);
check('filter: pending = 1', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('1 movimiento'));
await page.goto(`${BASE}/app/movimientos?month=all&q=%25%27%29%28*`);
check('hostile search is neutralized (no error)', (await page.getByTestId('movement-count').count()) === 1 && (await page.locator('[role=alert]:not(#__next-route-announcer__)').count()) === 0);
await page.goto(`${BASE}/app/movimientos?month=all&source=import`);
check('filter by source: no imports', ((await page.getByTestId('movement-count').textContent()) ?? '').startsWith('0 movimiento'));

// ── Export ─────────────────────────────────────────────────────────────────────────────────────────────
const res = await page.request.get(`${BASE}/app/exportar?month=2026-09`);
const csv = await res.text();
check('CSV served as attachment', res.status() === 200 && (res.headers()['content-disposition'] ?? '').includes('movimientos-2026-09.csv'));
check('CSV has 9 rows + header', csv.trim().split('\r\n').length === 10, String(csv.trim().split('\r\n').length));
check('CSV neutralizes formula injection', csv.includes(`"'=HYPERLINK(""http://evil"")"`) && !csv.includes(';"=HYPERLINK'));
check('CSV exact decimals and effect', csv.includes('"Retiro de efectivo";"Retiro de efectivo";"200.00";"PEN"') && csv.includes('"810.00"'));
check('CSV never includes B', !csv.includes('SECRET B'));

// ── Analysis ───────────────────────────────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/app/analisis?month=2026-09`);
check('analysis expenses S/ 4,220.00', (await page.getByTestId('an-expenses-PEN').textContent()) === 'S/ 4,220.00');
const cats = (await page.getByTestId('categories-PEN').textContent()) ?? '';
check('category deltas vs August', cats.includes('Alimentación') && cats.includes('S/ 810.00') && cats.includes('S/ 500.00'), cats);
const top = (await page.getByTestId('top-PEN').textContent()) ?? '';
check('top merchant is TIENDA RARA E2E', top.startsWith('TIENDA RARA E2E'), top);
check('USD analysed separately', (await page.getByTestId('analysis-USD').count()) === 1);
await browser.close();

for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  [${d.slice(0, 220)}]`}`);
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
