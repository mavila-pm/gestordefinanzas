/**
 * Registration (migration 029) against the REAL Supabase project, synthetic users only.
 * s16a: a new account that has NOT done the steps (seeded with a temporary password, i.e. the state right after the
 * email link created its session). s16b: a completed account. The email itself is not sent here (the shared SMTP
 * cap is for people); the signup action is covered by unit tests with Supabase stubbed (tests/password-reset.test.ts).
 */
import { ALERT, BASE, act, apiAs, login, probe, runSuite } from './lib.ts';

const A = probe('s16a');
const B = probe('s16b');
const NEW_PW = `nueva clave ${Date.now().toString(36)} 2026`;
// One number per account (migration 037): each run registers a fresh mobile; 987654321 is already taken by earlier runs.
const PHONE = `9${String(Date.now()).slice(-8)}`;
const TAKEN = '987654321';

await runSuite('registration', async ({ page, check }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // ── Email first: the public signup asks only for the email ─────────────────────────────────────────────
  await page.goto(`${BASE}/signup`);
  check('signup: one email field, no password/name fields, CTA "Continuar"',
    (await page.locator('main input:not([type=hidden])').count()) === 1 && (await page.locator('input[type=email]').count()) === 1
    && (await page.locator('main button[type=submit]').textContent()) === 'Continuar');

  // ── Invalid / used / expired link → one neutral message ────────────────────────────────────────────────
  await page.goto(`${BASE}/auth/confirm?token_hash=pkce_invalid000000000000&type=email`);
  check('invalid link → login with a clear message', page.url().startsWith(`${BASE}/login`) && (await page.getByTestId('link-error').count()) === 1, page.url());
  await page.goto(`${BASE}/crear-cuenta/perfil`);
  check('registration steps without a session → back to /signup', page.url().startsWith(`${BASE}/signup`), page.url());

  // ── Session from the link (simulated: seeded password) → the app sends a new account to the password step ──
  await login(page, A);
  await page.waitForURL(/\/crear-cuenta\/contrasena/, { timeout: 15000 }).catch(() => undefined);
  check('new account lands on "Crea tu contraseña"', page.url().startsWith(`${BASE}/crear-cuenta/contrasena`), page.url());
  check('password step names the account being created', ((await page.locator('main').textContent()) ?? '').includes(`Para ${A}`));
  const write = await page.request.post(`${BASE}/app`, { headers: { 'next-action': 'x', origin: BASE }, data: '[]' });
  check('writes (server actions) from an unfinished account are refused (403)', write.status() === 403, String(write.status()));
  await page.goto(`${BASE}/app`);
  check('the app is locked until registration is complete', page.url().startsWith(`${BASE}/crear-cuenta/contrasena`), page.url());

  const pw = page.locator('input[name=password]');
  const toggle = page.getByRole('button', { name: 'Mostrar contraseña' });
  await pw.fill('clave corta');
  await toggle.click();
  check('show password: visible, value kept, label flips', (await pw.getAttribute('type')) === 'text' && (await pw.inputValue()) === 'clave corta'
    && (await page.getByRole('button', { name: 'Ocultar contraseña' }).getAttribute('aria-pressed')) === 'true');
  const box = await page.getByRole('button', { name: 'Ocultar contraseña' }).boundingBox();
  check('toggle target ≥ 44 px', !!box && box.width >= 44 && box.height >= 44, JSON.stringify(box));
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  check('toggle works with the keyboard', (await pw.getAttribute('type')) === 'password');

  for (const [value, expect, label] of [['clave1', 'al menos 12', '< 12'], ['soloLetrasLargas', 'letras y números', 'only letters'], ['123456789012', 'letras y números', 'only numbers']] as const) {
    await pw.fill(value);
    await act(page, () => page.click('main button[type=submit]'));
    const err = (await page.locator(`main ${ALERT}`).textContent().catch(() => '')) ?? '';
    check(`password ${label} refused by the server ("${expect}")`, err.includes(expect) && page.url().includes('/contrasena'), err);
  }
  await pw.fill(NEW_PW);
  await Promise.all([page.waitForURL(/\/crear-cuenta\/perfil/, { timeout: 20000 }), page.click('main button[type=submit]')]);
  check('valid password → profile step', page.url().startsWith(`${BASE}/crear-cuenta/perfil`), page.url());
  await page.reload();
  check('refresh keeps the step (server-side state)', page.url().startsWith(`${BASE}/crear-cuenta/perfil`));

  // ── Profile: verified email shown, links, +18, consent ─────────────────────────────────────────────────
  check('verified email prefilled and read-only', (await page.getByTestId('profile-email').inputValue()) === A && (await page.getByTestId('profile-email').getAttribute('readonly')) !== null);
  check('consent unchecked by default', !(await page.locator('input[name=accept]').isChecked()));
  const terms = page.locator('.consent a[href="/terminos"]'); const privacy = page.locator('.consent a[href="/privacidad"]');
  check('Términos and Política de Privacidad are separate links opening in a new tab',
    (await terms.count()) === 1 && (await privacy.count()) === 1 && (await terms.getAttribute('target')) === '_blank');
  for (const path of ['/terminos', '/privacidad']) {
    const r = await page.request.get(`${BASE}${path}`);
    check(`${path} is public (200) and versioned`, r.status() === 200 && (await r.text()).includes('Versión'), String(r.status()));
  }

  await page.fill('input[name=givenNames]', 'Diego Armando');
  await page.fill('input[name=familyNames]', 'Prueba Sintética');
  // Peru-only phone: fixed +51, only the 9 digits are typed; letters/symbols never reach the field.
  check('phone shows a fixed +51 prefix', (await page.locator('.phone-prefix').textContent()) === '+51');
  await page.fill('input[name=phone]', '98a7-65 4321x0');
  check('only digits, at most 9', (await page.inputValue('input[name=phone]')) === '987654321', await page.inputValue('input[name=phone]'));
  // Server-side rules, with the browser's own constraints removed before each submit (React restores them on re-render).
  const unguard = () => page.evaluate(() => {
    document.querySelectorAll('main input').forEach((i) => { i.removeAttribute('max'); i.removeAttribute('required'); i.removeAttribute('pattern'); i.removeAttribute('maxlength'); });
    document.querySelector('main button[type=submit]')?.removeAttribute('disabled');
  });
  const submit = async () => { await unguard(); await act(page, () => page.click('main button[type=submit]')); };
  const alertText = async () => ((await page.locator(`main ${ALERT}`).allTextContents().catch(() => [])).join(' | '));
  const lima = new Date(Date.now() - 5 * 3600_000);
  const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  await page.fill('input[name=birthDate]', iso(lima.getUTCFullYear() - 18, lima.getUTCMonth(), lima.getUTCDate() + 1)); // 18 tomorrow
  check('under 18: message right away and Continue blocked', (await alertText()).includes('Velsuno es para personas mayores de 18 años.')
    && await page.locator('main button[type=submit]').isDisabled(), await alertText());
  await page.check('input[name=accept]');
  await submit();
  check('under 18 (one day short) refused by the server too', (await page.locator('main p[role=alert]').textContent().catch(() => '') ?? '').includes('mayores de 18'), await alertText());
  await page.fill('input[name=birthDate]', iso(lima.getUTCFullYear() - 18, lima.getUTCMonth(), lima.getUTCDate())); // 18 today
  check('turning 18 today is accepted (message cleared)', !(await alertText()).includes('mayores de 18') && !(await page.locator('main button[type=submit]').isDisabled()), await alertText());
  await page.fill('input[name=birthDate]', iso(lima.getUTCFullYear() - 30, 4, 20));
  await page.uncheck('input[name=accept]');
  await submit();
  check('consent not accepted → refused', (await alertText()).includes('acepta los Términos'), await alertText());
  await page.fill('input[name=phone]', '98765');
  await page.locator('input[name=phone]').blur();
  check('incomplete phone: message on leaving the field, Continue blocked', (await alertText()).includes('9 dígitos') && await page.locator('main button[type=submit]').isDisabled(), await alertText());
  // A tampered request (foreign number in the field) is refused by the server.
  await page.check('input[name=accept]');
  await page.evaluate(() => { (document.querySelector('input[name=phone]') as HTMLInputElement).value = '+34612345678'; });
  await submit();
  check('foreign / tampered phone → refused by the server', (await alertText()).includes('9 dígitos'), await alertText());
  await page.fill('input[name=phone]', TAKEN);
  await page.fill('input[name=birthDate]', iso(lima.getUTCFullYear() - 30, 4, 20));
  await page.check('input[name=accept]');
  await submit();
  check('a number already used by another account is refused', (await alertText()).includes('ya está registrado en otra cuenta'), await alertText());
  await page.fill('input[name=phone]', PHONE);
  await page.fill('input[name=birthDate]', iso(lima.getUTCFullYear() - 30, 4, 20));
  await page.check('input[name=accept]');
  await Promise.all([page.waitForURL(/\/bienvenida/, { timeout: 20000 }).catch(() => undefined), page.click('main button[type=submit]')]);
  check('account ready → welcome conversation', page.url().startsWith(`${BASE}/bienvenida`), `${page.url()} ${await alertText()}`);

  // ── Stored server-side, auditable ───────────────────────────────────────────────────────────────────────
  const sa = await apiAs(A, NEW_PW);
  const prof = (await sa.from('profiles').select('given_names, family_names, display_name, phone_e164, birth_date, registration_completed_at').single()).data;
  const acc = (await sa.from('legal_acceptances').select('kind, version')).data ?? [];
  check('profile saved (E.164, display name from first given name, completed)', prof?.phone_e164 === `+51${PHONE}` && prof?.display_name === 'Diego' && !!prof?.registration_completed_at, JSON.stringify(prof));
  check('Terms + Privacy acceptance recorded with version', acc.length === 2 && acc.every((x) => x.version === '2026-10-08'), JSON.stringify(acc));
  const tamper = await sa.from('profiles').update({ birth_date: '2015-01-01' }).eq('display_name', 'Diego').select();
  check('client cannot rewrite the birth date', !!tamper.error, JSON.stringify(tamper.error?.code));
  await sa.auth.signOut();

  // ── Login → logout → login again with the new password ─────────────────────────────────────────────────
  await page.goto(`${BASE}/crear-cuenta`);
  check('/crear-cuenta after completion goes on (no loop)', !page.url().includes('/crear-cuenta'), page.url());
  await page.context().clearCookies();
  await login(page, A, NEW_PW);
  check('login with the new password', !page.url().includes('/login') && !page.url().includes('/crear-cuenta'), page.url());
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]', A);
  await page.fill('input[name=password]', 'una clave equivocada 2026');
  await act(page, () => page.click('main button[type=submit]'));
  check('old/wrong password refused with the generic message', ((await page.locator(`main ${ALERT}`).textContent()) ?? '').includes('incorrectos'));

  check('the email stays filled after a failed login', (await page.inputValue('input[name=email]')) === A);

  // ── A completed account is never sent back to registration ─────────────────────────────────────────────
  await login(page, B);
  check('completed account goes to the app', page.url().startsWith(`${BASE}/app`), page.url());
});
