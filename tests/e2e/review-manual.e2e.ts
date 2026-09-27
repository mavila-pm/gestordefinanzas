/**
 * TASK-004 end-to-end check against the REAL Supabase project, driven through the running app.
 * Prereqs (docs/runbooks/e2e.md): migration 000004 applied; app running at E2E_BASE_URL; confirmed probe users
 * A and B (password E2E_PASSWORD); seeded review items (A: "E2E REVIEW A", S/100, card ****4821 not registered;
 * B: "E2E SECRET B", id in E2E_B_TX_ID).
 * Run: node --experimental-strip-types tests/e2e/review-manual.e2e.ts
 */
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import { existsSync, readdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const A = process.env.E2E_A_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const B_TX = process.env.E2E_B_TX_ID;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!A || !PASSWORD || !B_TX || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('E2E_A_EMAIL, E2E_PASSWORD, E2E_B_TX_ID, NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required');
}

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push([name, ok, detail]); };
const ALERT = '[role=alert]:not(#__next-route-announcer__)';

function chromiumPath(): string | undefined {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const p = dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
  return p && existsSync(p) ? p : undefined;
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(600); };

// Login A
await page.goto(`${BASE}/login`);
await page.fill('input[name=email]', A);
await page.fill('input[name=password]', PASSWORD);
await Promise.all([page.waitForURL(/\/app/), page.click('button[type=submit]')]);

// 1. Review queue: own item with a plain-language reason; never B's
await page.goto(`${BASE}/app/revisar`);
const queue = (await page.getByTestId('review-list').textContent()) ?? '';
check('queue lists A item', queue.includes('E2E REVIEW A'), queue);
check('queue explains the unidentified card', queue.includes('****4821 no identificada'), queue);
check('queue does NOT list B item', !queue.includes('E2E SECRET B'), queue);
check('queue shows no internal terms', !/BCP_EMAIL|BCP_SMS|fingerprint|parser/i.test(queue), queue);
check('nav badge counts pending items', (await page.getByTestId('review-count').textContent()) === '1');

// 2. Detail: register the card, then correct + confirm
await page.click('text=Corregir / ver origen');
await settle();
const detailUrl = page.url();
await page.fill('form[aria-label="Registrar tarjeta"] input[name=alias]', 'E2E Visa');
await page.selectOption('form[aria-label="Registrar tarjeta"] select[name=kind]', 'credit');
await page.click('form[aria-label="Registrar tarjeta"] button[type=submit]');
await settle();
check('card registration returns to the movement', page.url() === detailUrl, page.url());
const correction = 'form[aria-label="Corregir movimiento"]';
const cardValue = await page.locator(`${correction} select[name=cardId] option`, { hasText: 'E2E Visa' }).getAttribute('value');
await page.selectOption(`${correction} select[name=cardId]`, cardValue ?? '');
await page.selectOption(`${correction} select[name=categoryId]`, { label: 'Alimentación' });
await page.fill(`${correction} input[name=amount]`, '95.50');
await page.click(`${correction} button[value="1"]`);
await settle();
const status = await page.locator(`${correction} [role=status], ${correction} ${ALERT}`).first().textContent();
check('correction saved and confirmed', !!status?.includes('confirmado'), status ?? '');
await page.reload();
const history = (await page.getByTestId('audit-list').textContent()) ?? '';
check('history keeps original amount (S/ 100.00 → S/ 95.50)', history.includes('S/ 100.00 → S/ 95.50'), history);
check('origin still shows the bank notification', (await page.content()).includes('Notificación por'));

// 3. Queue empty
await page.goto(`${BASE}/app/revisar`);
check('queue empty after review', (await page.content()).includes('Todo al día'));

// 4. Manual entry: ATM withdrawal is not an expense
await page.goto(`${BASE}/app/movimientos/nuevo`);
await page.selectOption('select[name=type]', 'withdrawal');
await page.fill('input[name=amount]', '200');
await page.fill('input[name=description]', 'E2E CAJERO');
await Promise.all([page.waitForURL(/ok=1/), page.click('button[type=submit]')]);
check('manual entry saved', (await page.locator('[role=status]').first().textContent())?.includes('registrado') ?? false);
await page.goto(`${BASE}/app?month=2026-09`);
check('expenses = S/ 95.50 (withdrawal excluded)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 95.50',
  (await page.getByTestId('expenses-PEN').textContent()) ?? '');
check('withdrawal shown apart', (await page.content()).includes('Retiros de efectivo'));

// 5. B's movement through the UI: 404
const res = await page.goto(`${BASE}/app/movimientos/${B_TX}`);
check('A opening B movement -> 404', res?.status() === 404, String(res?.status()));

await browser.close();

// 6. Bypass attempts with A's own session straight against the API (what a malicious browser could do)
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: A, password: PASSWORD });
const own = await sb.from('transactions').select('id').limit(1).single();
const upd = await sb.from('transactions').update({ status: 'confirmed', amount_minor: 1 }).eq('id', own.data?.id ?? '');
check('direct UPDATE of own transaction denied (42501)', upd.error?.code === '42501', JSON.stringify(upd.error));
const ins = await sb.from('transactions').insert({ occurred_at: new Date().toISOString(), type: 'income', direction: 'inflow',
  amount_minor: 100, currency: 'PEN', status: 'confirmed', confidence: 'high', fingerprint: 'x' });
check('direct INSERT denied (42501)', ins.error?.code === '42501', JSON.stringify(ins.error));
const del = await sb.from('transactions').delete().eq('id', own.data?.id ?? '');
check('direct DELETE denied (42501)', del.error?.code === '42501', JSON.stringify(del.error));
const rb = await sb.rpc('review_transaction', { p_id: B_TX, p_action: 'confirm' });
check('RPC on B transaction -> not_found', rb.error?.message === 'not_found', JSON.stringify(rb.error));
const cb = await sb.rpc('correct_transaction', { p_id: B_TX, p_changes: { amount_minor: 1 }, p_confirm: true });
check('correction of B transaction -> not_found', cb.error?.message === 'not_found', JSON.stringify(cb.error));
const audit = await sb.from('audit_events').insert({ user_id: (await sb.auth.getUser()).data.user?.id, action: 'confirm' });
check('direct audit insert denied', !!audit.error, JSON.stringify(audit.error));
const helper = await sb.rpc('direction_for', { t: 'expense' });
check('internal helper not exposed', !!helper.error, JSON.stringify(helper.error));
await sb.auth.signOut();

for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  [${d.slice(0, 200)}]`}`);
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
