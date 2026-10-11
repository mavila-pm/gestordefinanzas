/**
 * Conversational onboarding + Preguntar + AI usage (ADR-0006) end-to-end against the REAL Supabase project.
 * The server runs with the deterministic fixture provider (scripts/e2e.sh), so inference paths are exercised
 * (reservation, validation, usage recording) with synthetic answers and synthetic images only.
 * s12a is a first-time user (demo allowlisted); s12b is another user whose data must stay invisible.
 */
import { act, apiAs, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s12a');
const B = probe('s12b');
const lastVelsuno = async (page: import('playwright-core').Page) => ((await page.getByTestId('velsuno-msg').last().textContent()) ?? '').replace(/\s+/g, ' ');
const send = (page: import('playwright-core').Page, text: string) => act(page, async () => { await page.fill('#chat-text', text); await page.click('form.composer button[type=submit]'); });
const tap = (page: import('playwright-core').Page, name: string) => act(page, () => page.locator('.chat-actions').getByRole('button', { name, exact: true }).last().click());

await runSuite('onboarding', async ({ page, check }) => {
  const api = await apiAs(A);
  const usage = async () => (await api.from('ai_usage').select('bucket,requests,weighted_tokens,camera_reads')).data ?? [];

  await login(page, A);
  await page.goto(`${BASE}/app`);
  await page.waitForURL(/\/bienvenida$/);
  check('first access goes to the conversation, not to an empty dashboard', page.url().endsWith('/bienvenida'));
  await page.getByTestId('velsuno-msg').nth(1).waitFor();
  const opening = (await page.getByTestId('velsuno-msg').allTextContents()).join(' ');
  check('opening: "Vamos a ordenar tus finanzas juntos." then dependiente / independiente, no step counter',
    opening.includes('Vamos a ordenar tus finanzas juntos.') && opening.includes('Antes de empezar, ¿trabajas como dependiente o independiente?') && !/paso \d/i.test(opening), opening);
  const options = await page.locator('.chat-actions').last().getByRole('button').allTextContents();
  check('two options under the question', JSON.stringify(options) === '["Dependiente","Independiente"]', JSON.stringify(options));
  const emptyBoxes = () => page.locator('.chat-card').evaluateAll((els) => els.filter((e) => !(e.textContent ?? '').trim()).length);
  check('no empty boxes under the messages', (await emptyBoxes()) === 0);

  // §5: many messy facts in one message → structured card + ONE important question.
  await send(page, 'Me pagan 5,700 el 5, uso BCP, pago el carro como el 10, debo en la tarjeta y también le debo plata a mi pareja.');
  let v = await lastVelsuno(page);
  check('understood card lists income, car, card and personal debt', v.includes('Entendí esto') && v.includes('S/ 5,700 · día 5') && v.includes('Carro') && v.includes('Tarjeta BCP') && v.includes('Deuda con tu pareja'), v);
  check('asks ONE question, by impact: today\'s balance (it blocks Dinero libre)', v.includes('¿Cuánto dinero tienes disponible hoy?'), v);
  const u0 = await usage();
  check('deterministic reading costs no AI usage (§54)', u0.every((r) => r.requests === 0), JSON.stringify(u0));

  await tap(page, 'No sé');
  v = await lastVelsuno(page);
  check('"No sé" moves on (unknown, never 0)', !v.includes('¿Cuánto dinero tienes disponible hoy') && !v.includes('Saldo de hoy S/ 0'), v);
  check('then other incomes, one question with Sí / No', v.includes('¿Tienes algún otro ingreso?'), v);
  await tap(page, 'No');
  v = await lastVelsuno(page);
  check('next: one payment at a time — the car (its day was given) needs its amount', v.includes('¿Cuánto pagas de carro?'), v);
  await send(page, '900');
  v = await lastVelsuno(page);
  check('a bare answer fills the pending question, said in one short line', v.includes('S/ 900') && v.toLowerCase().includes('carro') && !v.includes('Entendí'), v);
  check('next: other fixed payments, before the card', v.includes('¿Tienes algún otro pago fijo?'), v);

  await send(page, 'no, el carro es 950');
  v = await lastVelsuno(page);
  check('corrections replace the value', v.includes('S/ 950'), v);
  check('debts before cards: what is owed to the partner (one question)', v.includes('¿Cuánto le debes a tu pareja?'), v);
  await tap(page, 'No sé');
  v = await lastVelsuno(page);
  check('then the card, one field at a time: what is owed now', v.includes('¿Cuánto debes ahora en la tarjeta BCP?'), v);

  // Something the rules cannot read → the (fixture) provider is called and usage is recorded on the onboarding allowance.
  await send(page, 'me quedé misio antes de fin de mes');
  v = await lastVelsuno(page);
  const u1 = await usage();
  const onb = u1.find((r) => r.bucket === 'onboarding');
  check('provider path: fact extracted and usage recorded on the separate onboarding allowance', /gastos básicos/i.test(v) && onb?.requests === 1 && Number(onb.weighted_tokens) > 0, `${v} ${JSON.stringify(u1)}`);

  // Leave and come back: progress persists.
  const before = await page.getByTestId('user-msg').count();
  await page.reload();
  check('abandon and return: the conversation and facts persist', (await page.getByTestId('user-msg').count()) === before);

  // Camera: synthetic card statement → "Encontré esto" → Confirmar; one camera read; nothing applied before confirming.
  await act(page, () => page.setInputFiles('input[type=file]', 'tests/fixtures/ai/vision/card-bcp-pen.png'));
  v = await lastVelsuno(page);
  check('camera read shows compact extracted facts (no OCR jargon)', v.includes('Encontré esto') && v.includes('S/ 284.30') && v.includes('19 oct') && !/ocr|confidence|token/i.test(v), v);
  const state1 = (await api.from('onboarding_states').select('facts').single()).data!.facts as { debts: Array<{ minimumMinor: number | null }> };
  check('extraction is not applied before confirmation', state1.debts.every((d) => d.minimumMinor === null));
  await tap(page, 'Confirmar');
  const state2 = (await api.from('onboarding_states').select('facts').single()).data!.facts as { debts: Array<{ minimumMinor: number | null; last4: string | null }>; vision: unknown };
  check('confirmed facts merge into the same card (minimum 284.30, •••• 4821)', state2.debts.some((d) => d.minimumMinor === 28430 && d.last4 === '4821') && state2.vision === null, JSON.stringify(state2.debts));
  check('camera read counted once on the onboarding allowance', (await usage()).find((r) => r.bucket === 'onboarding')?.camera_reads === 1);
  const facts = JSON.stringify(state2);
  check('no image data is stored anywhere in the draft', !facts.includes('base64') && facts.length < 6000);

  await act(page, () => page.setInputFiles('input[type=file]', { name: 'estado.png', mimeType: 'image/png', buffer: Buffer.from('esto no es una imagen') }));
  check('invalid file is rejected by content, not by name', (await lastVelsuno(page)).includes('Solo puedo leer fotos o capturas'));

  // Summary → Empezar → real Resumen.
  if (!(await page.getByTestId('onboarding-summary').count())) await tap(page, 'Ver mi resumen');
  const summary = (await page.getByTestId('onboarding-summary').last().textContent()) ?? '';
  check('summary: "Revísalo antes de continuar", grouped, with what is pending',
    (await lastVelsuno(page)).includes('Este es el resumen de tus finanzas. Revísalo antes de continuar.') && summary.includes('Ingresos y fechas') && summary.includes('Deudas y tarjetas') && summary.includes('Por confirmar') && summary.includes('Saldo de hoy'), summary);
  check('the summary keeps states: estimated and unknown, never invented', summary.includes('aprox.') && summary.includes('Por confirmar'), summary);
  check('still no empty boxes in the whole conversation', (await emptyBoxes()) === 0);
  await page.reload();
  check('the summary persists after reloading', (await page.getByTestId('onboarding-summary').count()) >= 1);
  await Promise.all([page.waitForURL(`${BASE}/app`), page.locator('.chat-actions').getByRole('button', { name: 'Confirmar y continuar' }).last().click()]);
  check('"Confirmar y continuar" lands on the real Resumen (the tour starts there)', page.url() === `${BASE}/app`);
  const inc = (await api.from('expected_incomes').select('name,amount_minor,day_of_month')).data ?? [];
  const fx = (await api.from('fixed_expenses').select('name,amount_minor,amount_status')).data ?? [];
  const debts = (await api.from('debts').select('name,balance_minor')).data ?? [];
  check('onboarding feeds planning: income S/ 5,700 day 5', inc.length === 1 && inc[0]!.amount_minor === 570000 && inc[0]!.day_of_month === 5, JSON.stringify(inc));
  check('obligations written (carro S/ 950; card payment with minimum)', fx.some((o) => o.name === 'Carro' && o.amount_minor === 95000) && fx.some((o) => o.name === 'Tarjeta BCP' && o.amount_minor === 28430), JSON.stringify(fx));
  check('card debt written; personal debt with unknown balance is NOT invented', debts.length === 1 && debts[0]!.balance_minor === 243000, JSON.stringify(debts));
  await page.goto(`${BASE}/app`);
  check('after finishing, /app no longer redirects', page.url() === `${BASE}/app`);

  // First-use tour: dimmed page, the REAL element highlighted, bubble beside it; Anterior/Siguiente/Terminar; saved once.
  const bubble = page.getByTestId('tour-bubble');
  await bubble.waitFor();
  const stepId = () => page.getByTestId('tour').getAttribute('data-step');
  const spotOver = async (sel: string) => { await page.waitForTimeout(300); return page.evaluate((q) => {
    const spot = document.querySelector('.tour-spot')?.getBoundingClientRect();
    const el = [...document.querySelectorAll(q)].find((e) => e.getBoundingClientRect().width > 0)?.getBoundingClientRect();
    const ok = !!spot && !!el && spot.left <= el.left + 1 && spot.top <= el.top + 1 && spot.right >= el.right - 1 && spot.bottom >= el.bottom - 1;
    return ok ? '' : JSON.stringify({ spot, el });
  }, sel); };
  check('tour starts after the conversation, on Resumen', (await stepId()) === 'summary' && (await bubble.textContent())!.includes('Aquí ves cómo va tu dinero.'));
  await bubble.getByRole('button', { name: 'Siguiente' }).click();
  await bubble.getByRole('button', { name: 'Siguiente' }).click();
  const spotMov = await spotOver('.sidebar a[href="/app/movimientos?month=all"]');
  check('Movimientos step highlights the real sidebar entry', (await stepId()) === 'movements' && !spotMov, spotMov);
  const box = await bubble.boundingBox();
  const link = await page.locator('.sidebar a[href="/app/movimientos?month=all"]').boundingBox();
  check('desktop: the bubble sits beside the element, not over it', !!box && !!link && box.x >= link.x + link.width, JSON.stringify({ box, link }));
  await bubble.getByRole('button', { name: 'Anterior' }).click();
  check('Anterior goes back', (await stepId()) === 'available');
  await page.goto(`${BASE}/app/analisis`);
  await bubble.waitFor();
  check('progress survives navigation between screens', (await stepId()) === 'available');
  await page.keyboard.press('ArrowRight');
  check('arrow keys move between steps', (await stepId()) === 'movements');
  await bubble.getByRole('button', { name: 'Siguiente' }).click();
  for (const id of ['upcoming', 'cards', 'analysis', 'savings']) {
    check(`step ${id} points at a real element`, (await stepId()) === id && (await page.locator('.tour-spot').count()) === 1);
    await bubble.getByRole('button', { name: 'Siguiente' }).click();
  }
  const velsText = (await bubble.textContent()) ?? '';
  check('last step: Vels with examples of what to say', (await stepId()) === 'vels' && velsText.includes('Pago Netflix el día 15.') && velsText.includes('¿Me alcanza para comprar algo de S/ 300?') && !(await spotOver('[data-testid="vels-fab"]')), velsText);
  await bubble.getByRole('button', { name: 'Terminar' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="tour"]'));
  await page.waitForTimeout(500);
  check('Terminar saves it for the account', !!(await api.from('user_preferences').select('tour_completed_at').single()).data?.tour_completed_at);
  await page.goto(`${BASE}/app`);
  check('not shown again on the next visit', (await page.getByTestId('tour').count()) === 0);

  // Ajustes → Ayuda restarts it; on a phone the bubble never covers the bottom navigation; Saltar closes it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/app/ajustes/ayuda`);
  await Promise.all([page.waitForURL(/\/app\?recorrido=1$/), page.getByTestId('tour-restart').click()]);
  await bubble.waitFor();
  check('restart from Ajustes → Ayuda begins at step 1', (await stepId()) === 'summary');
  await bubble.getByRole('button', { name: 'Siguiente' }).click();
  await bubble.getByRole('button', { name: 'Siguiente' }).click();
  await bubble.getByRole('button', { name: 'Siguiente' }).click();
  const navTop = (await page.locator('.bottom-nav').boundingBox())!.y;
  const mb = (await bubble.boundingBox())!;
  check('mobile: Próximos pagos points to Más, the bubble stays above the navigation and inside the screen',
    (await stepId()) === 'upcoming' && !(await spotOver('.bottom-nav a[href="/app/mas"]')) && (await page.getByTestId('tour-via').textContent())!.includes('Más')
    && mb.y + mb.height <= navTop && mb.x >= 0 && mb.x + mb.width <= 390, JSON.stringify({ mb, navTop }));
  await page.locator('.bottom-nav a[href="/app/movimientos?month=all"]').click();
  await page.waitForURL(/\/app\/movimientos/);
  check('the page stays usable under the tour (never blocks)', page.url().includes('/app/movimientos'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="tour"]'));
  await page.waitForTimeout(500);
  check('Saltar / Escape closes it and saves it', !!(await api.from('user_preferences').select('tour_completed_at').single()).data?.tour_completed_at);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Preguntar: deterministic answers with engine numbers; zero AI usage for them.
  const month = () => usage().then((rows) => rows.find((r) => r.bucket.startsWith('m:'))?.requests ?? 0);
  const m0 = await month();
  await page.goto(`${BASE}/app/preguntar`);
  await send(page, '¿Cuánto tengo libre?');
  v = await lastVelsuno(page);
  check('asks only for the missing balance, in plain words', v === 'Claro. ¿Cuánto tienes disponible hoy?', v);
  await send(page, '3,000');
  v = await lastVelsuno(page);
  check('balance answer is saved and free money recalculated deterministically', v.startsWith('Listo: S/ 3,000 disponibles.') && /disponibles hasta|libres|Te faltan/.test(v), v);
  await send(page, '¿Puedo gastar S/ 100?');
  v = await lastVelsuno(page);
  check('"¿puedo gastar?" answered by the planner', /^(Sí\.|Ahí no te alcanza)/.test(v), v);
  check('deterministic questions consumed no AI usage', (await month()) === m0, String(await month()));
  await send(page, '¿qué opinas de mis finanzas en general?');
  check('uncovered question goes to the provider and is counted on the monthly bucket', (await month()) === m0 + 1);

  // Camera inside Preguntar: same pipeline; confirmed facts update the existing card, never duplicate it.
  await act(page, () => page.setInputFiles('input[type=file]', 'tests/fixtures/ai/vision/card-bcp-pen.png'));
  v = await lastVelsuno(page);
  check('Preguntar camera shows the extracted facts for confirmation', v.includes('Encontré esto') && v.includes('S/ 284.30'), v);
  check('the pending proposal is not sent to the browser', !(await page.content()).includes('minimumMinor'));
  const debtsBefore = (await api.from('debts').select('id')).data?.length ?? 0;
  await tap(page, 'Confirmar');
  const cardPays = ((await api.from('fixed_expenses').select('name')).data ?? []).filter((o) => o.name === 'Tarjeta BCP');
  check('confirming updates the same card (no duplicate debt or payment)', ((await api.from('debts').select('id')).data?.length ?? 0) === debtsBefore && cardPays.length === 1, `${debtsBefore} ${cardPays.length}`);
  check('Preguntar camera confirmation answers briefly', (await lastVelsuno(page)).startsWith('Listo'), await lastVelsuno(page));
  const monthReads = async () => (await usage()).find((r) => r.bucket.startsWith('m:'))?.camera_reads ?? 0;
  await act(page, () => page.setInputFiles('input[type=file]', 'tests/fixtures/ai/vision/card-bcp-pen.png'));
  const reads1 = await monthReads(); // a new read after the confirmed one is charged
  await act(page, () => page.setInputFiles('input[type=file]', 'tests/fixtures/ai/vision/card-bcp-pen.png'));
  check('same photo again while the proposal is open (retry / double tap): same proposal, no second camera read', (await lastVelsuno(page)).includes('Encontré esto') && (await monthReads()) === reads1, `${reads1} → ${await monthReads()}`);

  // Plan / usage view and demo controls.
  await page.goto(`${BASE}/app/ajustes/plan`);
  const ai = (await page.getByTestId('ai-usage').textContent()) ?? '';
  check('usage shown as a percent meter and camera count, never tokens', /\d+ % usado/.test(ai) && ai.includes('2 de 2') && !/token/i.test(ai), ai);
  const demo = page.getByTestId('demo-controls');
  await demo.locator('label.segment', { hasText: 'Plus' }).click();
  await act(page, () => demo.getByRole('button', { name: 'Aplicar' }).click());
  await page.reload();
  const ai2 = `${(await page.getByTestId('ai-usage').textContent()) ?? ''} ${(await page.getByTestId('plan').textContent()) ?? ''}`;
  check('demo simulates Plus limits (50 camera reads; the Preguntar read counts), labelled as simulation', ai2.includes('2 de 50') && ai2.includes('Simulación Plus'), ai2);
  check('the real subscription is untouched', ((await api.from('subscriptions').select('plan')).data ?? []).length === 0);

  // Demo reset restores the first-time experience and removes ONLY what onboarding created.
  await Promise.all([page.waitForURL(/\/bienvenida$/), page.getByTestId('demo-controls').getByRole('button', { name: 'Reiniciar bienvenida demo' }).click()]);
  const after = await Promise.all([api.from('expected_incomes').select('id'), api.from('debts').select('id'), api.from('balance_snapshots').select('amount_minor')]);
  check('reset removes exactly the onboarding rows; data created later (assistant balance) stays',
    after[0].data!.length === 0 && after[1].data!.length === 0 && after[2].data!.length === 1 && after[2].data![0]!.amount_minor === 300000, JSON.stringify(after.map((r) => r.data)));
  check('reset gives the onboarding allowance back', (await usage()).find((r) => r.bucket === 'onboarding')?.requests === 0);
  await page.getByTestId('velsuno-msg').nth(1).waitFor();
  check('fresh greeting after reset', (await page.getByTestId('velsuno-msg').count()) === 2);

  // Dependiente route in the browser (after the reset), on a phone: one question per message, exact copy.
  await page.setViewportSize({ width: 390, height: 844 });
  // Regression: a doubt is never an answer — explained, the same two options, nothing chosen.
  await send(page, '¿Qué es dependiente o independiente?');
  v = await lastVelsuno(page);
  const help = await page.locator('.chat-actions').last().getByRole('button').allTextContents();
  const gap = await page.locator('.chat-actions').last().evaluate((e) => parseFloat(getComputedStyle(e).columnGap));
  check('"¿Qué es dependiente o independiente?" → explanation, same question, two separated options',
    v.startsWith('Dependiente: trabajas para una empresa y recibes un sueldo.') && v.includes('¿Con cuál te identificas más?') && JSON.stringify(help) === '["Dependiente","Independiente"]' && gap >= 12, `${v} ${JSON.stringify(help)} ${gap}`);
  check('nothing was chosen or written for the doubt', !((await api.from('onboarding_states').select('facts').single()).data!.facts as { work?: string }).work);
  await tap(page, 'Dependiente');
  check('dependiente → "Perfecto. ¿Cuánto recibes de sueldo al mes?"', (await lastVelsuno(page)).startsWith('Perfecto. ¿Cuánto recibes de sueldo al mes?'), await lastVelsuno(page));
  await send(page, '3,500');
  check('→ "Entiendo. ¿En qué fechas te pagan?"', (await lastVelsuno(page)).startsWith('Entiendo. ¿En qué fechas te pagan?'), await lastVelsuno(page));
  await send(page, '15 y 30');
  v = await lastVelsuno(page);
  check('two pay dates understood → other income asked', v.includes('días 15 y 30') && v.includes('¿Tienes algún otro ingreso aparte de tu sueldo?'), v);
  check('phone: no empty boxes, nothing wider than the screen', (await emptyBoxes()) === 0
    && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/onb-phone.png` });
  await page.setViewportSize({ width: 1280, height: 720 });
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/onb-desktop.png` });

  // Isolation.
  const msgs = (await api.from('conversation_messages').select('body')).data ?? [];
  check('A never sees B\'s conversation, usage or planning rows', !msgs.some((m) => m.body.includes('B secreto'))
    && !(await usage()).some((r) => r.weighted_tokens === 777) && !((await api.from('expected_incomes').select('name')).data ?? []).some((r) => r.name.includes('B sueldo')));
  const bId = (await (await apiAs(B)).auth.getUser()).data.user!.id;
  const forge = await api.from('conversation_messages').insert({ user_id: bId, thread: 'assistant', role: 'user', body: 'x' });
  check('A cannot write into B\'s conversation', !!forge.error);
  const writeUsage = await api.from('ai_usage').update({ weighted_tokens: 0 }).eq('bucket', 'onboarding').select();
  check('clients cannot reset their own usage', !!writeUsage.error || (writeUsage.data ?? []).length === 0);

  await page.context().clearCookies();
  await login(page, B);
  await page.goto(`${BASE}/app`);
  check('a user who already finished onboarding is never sent back to it', page.url() === `${BASE}/app`);
});
