/**
 * End-to-end check against the REAL Supabase project, driven through the running app.
 * access to the Supabase host.
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { BASE, act, login, passCap, probe, runSuite } from './lib.ts';

const A = probe('s3a');
const B = probe('s3b');
// Unknown email, new per run: the lockout it triggers is stored for real and must not leak into the next run.
const NOBODY = `nobody-${Date.now()}@invalid.test`;

await runSuite('auth-dashboard', async ({ page, check }) => {
  async function loginAttempt(email: string, password: string) {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', password);
    await passCap(page);
    await act(page, () => page.click('form button[type=submit]'));
  }

  // 1. Protected route without session
  await page.goto(`${BASE}/app`);
  check('unauthenticated /app redirects to /login', page.url().startsWith(`${BASE}/login`), page.url());

  // 2. Wrong password and unknown email: identical generic message (no enumeration)
  await loginAttempt(A, 'wrong-password-123');
  const loginErr = await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent();
  check('wrong password -> generic error', !!loginErr?.includes('Correo o contraseña incorrectos'), loginErr ?? '');
  await loginAttempt(NOBODY, 'whatever-123');
  check('unknown email -> same generic error', (await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent()) === loginErr);
  check('generic error text is the approved one', loginErr === 'Correo o contraseña incorrectos. Por favor, inténtalo de nuevo.', loginErr ?? '');
  check('login shows the slogan and working legal links', (await page.locator('.auth-tagline').textContent()) === 'Tu dinero, más claro.'
    && (await page.locator('.auth-legal a[href="/terminos"]').count()) === 1 && (await page.locator('.auth-legal a[href="/privacidad"]').count()) === 1);
  // Lockout (migration 033): 3rd failure on the same email locks it 5 min; a reload does not lift it; same for any email.
  const LOCKED = 'Demasiados intentos fallidos. Por seguridad, podrás intentarlo nuevamente en 5 minutos.';
  await loginAttempt(NOBODY, 'whatever-123'); // 2nd for this email
  await loginAttempt(NOBODY, 'whatever-123'); // 3rd
  const third = await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent();
  check('3rd failed attempt announces the 5-minute lock', third === LOCKED, third ?? '');
  await page.reload();
  await loginAttempt(NOBODY, 'whatever-123');
  check('after a reload the lock still applies (stored server-side)', (await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent()) === LOCKED);

  // 3. Login A -> dashboard with A's data only (RLS through the app)
  await login(page, A);
  check('login A lands on /app', page.url().startsWith(`${BASE}/app`), page.url());
  await page.goto(`${BASE}/app?month=2026-09`);
  const expenses = await page.getByTestId('expenses-PEN').textContent();
  check('A expenses = S/ 100.00 (purchase + card payment + ATM)', expenses === 'S/ 100.00', expenses ?? '');
  const list = (await page.getByTestId('tx-list').textContent()) ?? '';
  check('A sees own merchant', list.includes('E2E RESTAURANTE A'), list);
  check('A does NOT see B merchant', !list.includes('E2E SECRET B'), list);
  check('withdrawal shown apart, not as expense', (await page.content()).includes('Retiros de efectivo'));

  check('Privacidad: account deletion is a request, never a direct destructive button', await (async () => {
    await page.goto(`${BASE}/app/ajustes/privacidad`);
    const del = page.getByText(/Eliminar mi cuenta/);
    return (await del.count()) >= 1 && (await page.getByRole('button', { name: /Eliminar mi cuenta/ }).count()) === 0;
  })());
  // Ajustes → Seguridad → Cambiar contraseña: sheet, show/hide, client validation (nothing is sent, the probe password stays as is).
  await page.goto(`${BASE}/app/ajustes/seguridad`);
  await page.getByRole('button', { name: 'Cambiar contraseña' }).first().click();
  const sheet = page.getByTestId('password-sheet');
  const npw = sheet.locator('input[name=password]');
  check('Cambiar contraseña opens from Ajustes with one main action', await sheet.isVisible()
    && (await sheet.locator('button[type=submit]').count()) === 1 && (await sheet.locator('button[type=submit]').textContent()) === 'Cambiar contraseña');
  await npw.fill('clave corta');
  await sheet.getByRole('button', { name: 'Mostrar contraseña' }).click();
  check('change password: show keeps the value', (await npw.getAttribute('type')) === 'text' && (await npw.inputValue()) === 'clave corta');
  await sheet.getByRole('button', { name: 'Ocultar contraseña' }).click();
  check('change password: hide again', (await npw.getAttribute('type')) === 'password');
  for (const [value, expected] of [['abc12345678', 'Usa al menos 12 caracteres.'], ['soloLetrasLargas', 'Combina letras y números.'], ['123456789012', 'Combina letras y números.']] as const) {
    await npw.fill(value);
    await sheet.locator('button[type=submit]').click();
    check(`change password: client refuses "${value}"`, (await sheet.locator('[role=alert]').textContent()) === expected);
  }
  await page.keyboard.press('Escape');

  // 4. Logout (Ajustes → Seguridad)
  // Server-action redirect = client-side navigation (no new load event): wait for the URL instead of networkidle.
  await page.goto(`${BASE}/app/ajustes/seguridad`);
  await Promise.all([page.waitForURL(/\/login/), page.getByRole('button', { name: 'Cerrar sesión', exact: true }).first().click()]);
  await page.goto(`${BASE}/app`);
  check('after logout /app redirects to /login', page.url().startsWith(`${BASE}/login`), page.url());
  // The successful sign-in reset A's counter: 1 earlier failure + 2 now would lock if it had not.
  await loginAttempt(A, 'wrong-password-123');
  await loginAttempt(A, 'wrong-password-123');
  const afterReset = await page.locator('[role=alert]:not(#__next-route-announcer__)').textContent();
  check('success resets the counter (2 new failures: no lock yet)', afterReset === 'Correo o contraseña incorrectos. Por favor, inténtalo de nuevo.', afterReset ?? '');
  await login(page, A);
  check('3rd try with the right password still signs in (and clears the pending lock)', page.url().startsWith(`${BASE}/app`), page.url());
  await page.goto(`${BASE}/app/ajustes/seguridad`);
  await Promise.all([page.waitForURL(/\/login/), page.getByRole('button', { name: 'Cerrar sesión', exact: true }).first().click()]);

  // 5. Password recovery for an unknown email: neutral message (Supabase sends nothing)
  await page.goto(`${BASE}/forgot-password`);
  await page.fill('input[name=email]', NOBODY);
  await passCap(page);
  await act(page, () => page.click('form button[type=submit]'));
  const resetMsg = await page.locator('[role=status], [role=alert]:not(#__next-route-announcer__)').first().textContent();
  check('forgot-password neutral message', !!resetMsg?.includes('Si existe una cuenta'), resetMsg ?? '');
  const nextCookie = (await page.context().cookies()).find((c) => c.name === 'gf_auth_next');
  check('recovery remembers /reset-password in an httpOnly /auth cookie (callback URL stays query-free)',
    nextCookie?.value === '%2Freset-password' || nextCookie?.value === '/reset-password'
      ? nextCookie.httpOnly && nextCookie.path === '/auth' : false, JSON.stringify(nextCookie));

  // 6. Signup asks only for the email (registration suite walks the steps; the send is unit-tested, no email here)
  await page.goto(`${BASE}/signup`);
  check('signup: email only, then "Continuar"', (await page.locator('input[name=password]').count()) === 0
    && (await page.locator('input[type=email]').count()) === 1 && (await page.locator('main button[type=submit]').textContent()) === 'Continuar');
});
