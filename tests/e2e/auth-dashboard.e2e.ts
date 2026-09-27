/**
 * End-to-end check against the REAL Supabase project, driven through the running app.
 * Prereqs (docs/runbooks/e2e.md): app running at E2E_BASE_URL; two confirmed probe users created
 * beforehand (E2E_A_EMAIL / E2E_B_EMAIL, password E2E_PASSWORD) with seeded transactions; network
 * access to the Supabase host.
 * Run: node --experimental-strip-types tests/e2e/auth-dashboard.e2e.ts
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const A = process.env.E2E_A_EMAIL;
const B = process.env.E2E_B_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
if (!A || !B || !PASSWORD) throw new Error('E2E_A_EMAIL, E2E_B_EMAIL and E2E_PASSWORD are required');

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
const page = await browser.newPage();

async function submit() {
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[type=submit]')]);
  await page.waitForTimeout(500);
}

async function login(email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await submit();
}

// 1. Protected route without session
await page.goto(`${BASE}/app`);
check('unauthenticated /app redirects to /login', page.url().startsWith(`${BASE}/login`), page.url());

// 2. Wrong password and unknown email: identical generic message (no enumeration)
await login(A, 'wrong-password-123');
const loginErr = await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent();
check('wrong password -> generic error', !!loginErr?.includes('Correo o contraseña incorrectos'), loginErr ?? '');
await login('nobody-e2e@invalid.test', 'whatever-123');
check('unknown email -> same generic error', (await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent()) === loginErr);

// 3. Login A -> dashboard with A's data only (RLS through the app)
await login(A, PASSWORD);
check('login A lands on /app', page.url().startsWith(`${BASE}/app`), page.url());
await page.goto(`${BASE}/app?month=2026-09`);
const expenses = await page.getByTestId('expenses-PEN').textContent();
check('A expenses = S/ 100.00 (purchase + card payment + ATM)', expenses === 'S/ 100.00', expenses ?? '');
const list = (await page.getByTestId('tx-list').textContent()) ?? '';
check('A sees own merchant', list.includes('E2E RESTAURANTE A'), list);
check('A does NOT see B merchant', !list.includes('E2E SECRET B'), list);
check('withdrawal shown apart, not as expense', (await page.content()).includes('Retiros de efectivo'));

// 4. Logout
await page.click('text=Cerrar sesión');
await page.waitForLoadState('networkidle');
await page.goto(`${BASE}/app`);
check('after logout /app redirects to /login', page.url().startsWith(`${BASE}/login`), page.url());

// 5. Password recovery for an unknown email: neutral message (Supabase sends nothing)
await page.goto(`${BASE}/forgot-password`);
await page.fill('input[name=email]', 'nobody-e2e@invalid.test');
await submit();
const resetMsg = await page.locator('[role=status], [role=alert]:not(#__next-route-announcer__)').first().textContent();
check('forgot-password neutral message', !!resetMsg?.includes('Si existe una cuenta'), resetMsg ?? '');

// 6. Signup with an already registered email: neutral message (no enumeration)
await page.goto(`${BASE}/signup`);
await page.fill('input[name=email]', B);
await page.fill('input[name=password]', 'another-pass-123');
await submit();
const signupMsg = await page.locator('[role=status], [role=alert]:not(#__next-route-announcer__)').first().textContent();
check('signup existing email -> neutral message', !!signupMsg?.includes('Si el correo es válido'), signupMsg ?? '');

await browser.close();
for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  [${d.slice(0, 160)}]`}`);
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
