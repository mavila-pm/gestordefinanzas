/**
 * The full real conversation of 2026-10-11 (prueba-bienvenida-4), typed in the browser against the REAL Supabase
 * project; after "Confirmar y continuar" the rows written are read back and compared with what was said.
 * s17a: registered, no onboarding yet (deterministic reading: the fixture provider is on, nothing here needs it).
 */
import { act, apiAs, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s17a');
type Page = import('playwright-core').Page;
const last = async (page: Page) => ((await page.getByTestId('velsuno-msg').last().textContent()) ?? '').replace(/\s+/g, ' ');
const send = (page: Page, text: string) => act(page, async () => { await page.fill('#chat-text', text); await page.click('form.composer button[type=submit]'); });

const TURNS: Array<[string, RegExp]> = [
  ['Que es eso?', /¿Con cuál te identificas más\?/],
  ['Dependiente', /^Perfecto\. ¿Cuánto recibes de sueldo al mes\?/],
  ['3000', /^Entiendo\. ¿En qué fechas te pagan\?/],
  ['1ro de cada mes', /S\/ 3,000, día 1\..*¿Tienes algún otro ingreso aparte de tu sueldo\?/],
  ['Sí', /^¿De dónde viene ese ingreso adicional\?/],
  ['me pagan como diseñador 500 soles cada 1ro', /Recibes S\/ 500 por tu trabajo como diseñador el día 1 de cada mes\..*¿Tienes algún otro ingreso\?/],
  ['No', /¿Cuánto dinero tienes hoy entre tus cuentas y efectivo\?/],
  ['1000 soles en digital en mi cuenta de bcp y 100 soles en efectivo', /en tus cuentas tienes S\/ 1,000 y en efectivo S\/ 100\. En total, S\/ 1,100\..*¿Qué pagos fijos/],
  ['Pago 100 de luz\n100 de agua\n1000 de alquiler\n\ntodo lo pago el 5 de cada mes', /Listo: luz S\/ 100, agua S\/ 100 y alquiler S\/ 1,000, todos el 5\..*¿Tienes algún otro pago fijo\?/],
  ['te dije que pago luz 100 agua 100 y 1000 de alquiler cada 5 de cada mes', /luz S\/ 100, agua S\/ 100 y alquiler S\/ 1,000.*¿Tienes deudas o préstamos\?/],
  ['si pago mi prestamo de mic arro 250 soles mesnaules cada 8 de cada mes y pago tambien  un prestamo de roberto mi amigo que me presto 100 y le pago 10 soles cada mes voy pagandole 30 soles asi que me faltan 70 que ire pagando 10 soles cada mes de aqui en adelante.',
    /cuota S\/ 250 · día 8.*deuda con Roberto \(debes S\/ 70 · cuota S\/ 10 · prestaron S\/ 100\).*¿Con qué banco o entidad es el préstamo\?/],
  ['bcp', /¿Qué tipo de préstamo es\?/],
  ['Vehicular', /¿Cuánto te falta pagar\?/],
  ['no sé', /¿De cuántas cuotas es/],
  ['5', /5 cuotas\..*¿Tienes tarjeta de crédito\?/],
  ['si', /¿De qué banco es\?/],
  ['bcp', /¿Cuánto debes ahora en la tarjeta BCP\?/],
  ['1400', /¿Cuál es el pago mínimo de la tarjeta BCP\?/],
  ['10 soles pero mi pago mensual es de 100 soles', /el mínimo es S\/ 10 y sueles pagar S\/ 100 al mes\..*¿Qué día vence/],
  ['19 de cada mes', /Vence el 19\..*¿Pagas alguna suscripción/],
  ['si notion 24 dolares mensual y faceit 5 dolares', /Notion US\$ 24 y Faceit US\$ 5\..*¿Qué día te cobran Notion\?/],
  ['no sé', /el día de Notion queda por confirmar\..*¿Qué día te cobran Faceit\?/],
  ['no sé', /el día de Faceit queda por confirmar\..*¿Cuánto gastas al mes en lo básico/],
  ['comida 500 compro normalmente cada 30 y transporte 300 en gasolina', /comida S\/ 500 y transporte S\/ 300 al mes\..*¿Cuánto te gustaría ahorrar/],
  ['10,000 soles', /Ojo: tu meta de S\/ 10,000 al mes supera tus ingresos conocidos \(S\/ 3,500 al mes\)\..*Este es el resumen de tus finanzas/],
];

await runSuite('onboarding-real', async ({ page, check }) => {
  const api = await apiAs(A);
  await login(page, A);
  await page.goto(`${BASE}/app`);
  await page.waitForURL(/\/bienvenida$/);
  await page.getByTestId('velsuno-msg').nth(1).waitFor();
  for (const [text, expected] of TURNS) {
    await send(page, text);
    const v = await last(page);
    check(`"${text.slice(0, 40).replace(/\n/g, ' ')}" → ${expected.source.slice(0, 50)}`, expected.test(v), v);
  }
  const summary = (await page.getByTestId('onboarding-summary').last().textContent()) ?? '';
  check('summary lists exactly what was said', ['Diseñador', 'S/ 500', 'cuentas S/ 1,000 · efectivo S/ 100', 'Luz', 'Agua', 'Alquiler', 'cuota S/ 250', 'Debes S/ 70', 'mínimo S/ 10', 'pagas S/ 100 al mes', 'Notion', 'US$ 24', 'Faceit', 'US$ 5', 'S/ 10,000 al mes'].every((s) => summary.includes(s)), summary);
  await Promise.all([page.waitForURL(`${BASE}/app`), page.locator('.chat-actions').getByRole('button', { name: 'Confirmar y continuar' }).last().click()]);

  // The database, after confirming: every record as said, no duplicates, PEN and USD apart.
  const inc = (await api.from('expected_incomes').select('name,amount_minor,amount_status,frequency,day_of_month').order('created_at')).data ?? [];
  check('incomes: Sueldo S/ 3,000 day 1 + Diseñador S/ 500 confirmed day 1 (two rows)', JSON.stringify(inc.map((r) => [r.name, r.amount_minor, r.amount_status, r.frequency, r.day_of_month]))
    === JSON.stringify([['Sueldo', 300000, 'confirmed', 'monthly', 1], ['Diseñador', 50000, 'confirmed', 'monthly', 1]]), JSON.stringify(inc));
  const fx = (await api.from('fixed_expenses').select('name,kind,currency,amount_minor,due_day,notes').order('created_at')).data ?? [];
  const row = (n: string) => fx.filter((r) => r.name === n);
  check('payments: luz 100, agua 100, alquiler 1,000 — one row each, all day 5', ['Luz', 'Agua', 'Alquiler'].every((n) => row(n).length === 1 && row(n)[0]!.due_day === 5)
    && row('Luz')[0]!.amount_minor === 10000 && row('Agua')[0]!.amount_minor === 10000 && row('Alquiler')[0]!.amount_minor === 100000, JSON.stringify(fx));
  check('vehicle loan: planned installment S/ 250 on day 8', row('Préstamo vehicular BCP').length === 1 && row('Préstamo vehicular BCP')[0]!.amount_minor === 25000 && row('Préstamo vehicular BCP')[0]!.due_day === 8, JSON.stringify(fx));
  check('card BCP: planned payment S/ 100 (usual), minimum S/ 10 kept apart', row('Tarjeta BCP').length === 1 && row('Tarjeta BCP')[0]!.amount_minor === 10000 && /S\/ 10\.00/.test(row('Tarjeta BCP')[0]!.notes ?? ''), JSON.stringify(row('Tarjeta BCP')));
  check('subscriptions: Notion US$ 24 and Faceit US$ 5 in USD, no day invented', row('Notion')[0]?.currency === 'USD' && row('Notion')[0]?.amount_minor === 2400 && row('Notion')[0]?.due_day === null
    && row('Faceit')[0]?.currency === 'USD' && row('Faceit')[0]?.amount_minor === 500 && row('Faceit')[0]?.due_day === null, JSON.stringify(fx));
  const debts = (await api.from('debts').select('name,lender,principal_minor,balance_minor,installment_minor,due_day').order('created_at')).data ?? [];
  const roberto = debts.find((d) => d.name === 'Deuda con Roberto');
  check('Roberto: lent 100, owed 70, 10 a month', !!roberto && roberto.lender === 'Roberto' && roberto.principal_minor === 10000 && roberto.balance_minor === 7000 && roberto.installment_minor === 1000, JSON.stringify(debts));
  check('the vehicle loan is not written as a debt with an invented balance', !debts.some((d) => d.name === 'Préstamo vehicular BCP'), JSON.stringify(debts));
  check('card debt S/ 1,400', debts.some((d) => d.name === 'Tarjeta BCP' && d.balance_minor === 140000), JSON.stringify(debts));
  const bal = (await api.from('balance_snapshots').select('amount_minor,bank_minor,cash_minor')).data ?? [];
  check('money today: S/ 1,100 = cuentas 1,000 + efectivo 100 (one row)', bal.length === 1 && bal[0]!.amount_minor === 110000 && bal[0]!.bank_minor === 100000 && bal[0]!.cash_minor === 10000, JSON.stringify(bal));
  const goal = (await api.from('planning_settings').select('currency,savings_goal_minor,essentials_monthly_minor')).data ?? [];
  check('savings goal kept as said (S/ 10,000), essentials = comida 500 + transporte 300', goal.some((g) => g.currency === 'PEN' && g.savings_goal_minor === 1000000 && g.essentials_monthly_minor === 80000), JSON.stringify(goal));
});
