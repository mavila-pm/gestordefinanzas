/**
 * Shared E2E helpers (docs/runbooks/e2e.md). Suites run against the REAL Supabase project through the running app,
 * with the probe users seeded by tests/e2e/seed.sql (one A/B pair per suite). Run them through scripts/e2e.sh.
 * No fixed sleeps: every wait is on an observable state (response, URL, form not busy, text changed).
 */
import { chromium, type Browser, type Page, type Response } from 'playwright-core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
export const ALERT = '[role=alert]:not(#__next-route-announcer__)';
/**
 * Seed run per tag (.e2e/runs.json, written by `scripts/e2e.sh render-seed`): each render creates NEW synthetic users
 * e2e-<tag>-<run>@gestordefinanzas.invalid, so a seed never collides with leftovers of an earlier run.
 */
const RUNS: Record<string, string> = (() => { try { return JSON.parse(readFileSync('.e2e/runs.json', 'utf8')); } catch { return {}; } })();
function runOf(tag: string): string {
  const run = RUNS[tag];
  if (!run || !/^[a-z0-9]{8,20}$/.test(run)) throw new Error(`no E2E seed run for ${tag}: render and apply the seed first (scripts/e2e.sh render-seed)`);
  return run;
}
/** Probe user email for a seed tag (s3a, s4a, ...), always in the synthetic namespace. */
export const probe = (tag: string) => `e2e-${tag}-${runOf(tag)}@gestordefinanzas.invalid`;
/** Same derivation as seed.sql: md5('<run>:<name>')::uuid. */
export const fixedId = (tag: string, name: string) => {
  const h = createHash('md5').update(`${runOf(tag)}:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** Ids of the B rows the suites attack directly (seed.sql). */
export const B_TX = {
  get review() { return fixedId('s4b', 'e4b1'); }, get import() { return fixedId('s56b', 'e56b'); },
  get split() { return fixedId('s10b', 'e10b'); }, get obligation() { return fixedId('s11b', 'e11b'); },
};

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing E2E env: ${name}`);
  return v;
}
export const PASSWORD = () => need('E2E_PASSWORD');

/** Anon (publishable-key) client signed in as a probe user: exercises RLS/grants exactly like an attacker would. */
export async function apiAs(email: string, password = PASSWORD()): Promise<SupabaseClient> {
  const client = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`api sign-in failed for ${email}: ${error.message}`);
  return client;
}

/** Key-order-independent JSON equality (jsonb returns object keys in its own order). */
export const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

function chromiumPath(): string | undefined {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const p = dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
  return p && existsSync(p) ? p : undefined;
}

// Server action POST; before hydration the form posts natively (no next-action header), so any page POST counts.
const DEBUG = !!process.env.E2E_DEBUG;
const isServerAction = (r: Response) => r.request().method() === 'POST' && (r.request().resourceType() === 'document' || !!r.request().headers()['next-action']);

/** Runs a trigger that submits a server action and waits until the action answered and no form is busy. */
export async function act(page: Page, trigger: () => Promise<unknown>): Promise<void> {
  await Promise.all([page.waitForResponse(isServerAction, { timeout: 20000 }), trigger()]);
  await page.waitForFunction(() => !document.querySelector('form[aria-busy=true]'), undefined, { timeout: 20000 });
}

/** Runs a trigger that navigates (link, redirect) and waits for the URL to change. */
export async function nav(page: Page, trigger: () => Promise<unknown>): Promise<void> {
  const before = page.url();
  await Promise.all([page.waitForURL((u) => u.toString() !== before, { timeout: 20000 }), trigger()]);
}

/** Server actions re-render in place: wait until the element's text actually changes. */
export const changed = (page: Page, testId: string, before: string) => page.waitForFunction(
  (a: { id: string; old: string }) => (document.querySelector(`[data-testid="${a.id}"]`)?.textContent ?? '') !== a.old,
  { id: testId, old: before }, { timeout: 20000 });

export async function login(page: Page, email: string, password = PASSWORD()): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await nav(page, () => page.click('form button[type=submit]'));
}

export interface Suite {
  browser: Browser;
  page: Page;
  check: (name: string, ok: boolean, detail?: string) => void;
}

/**
 * Runs a suite: launches the browser, collects checks, always closes the browser and prints one line per check.
 * On an unexpected error it prints a one-step diagnosis (error, URL, visible alert/status, main text excerpt).
 */
export async function runSuite(name: string, body: (s: Suite) => Promise<void>): Promise<never> {
  const results: Array<[string, boolean, string?]> = [];
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage();
  if (DEBUG) page.on('request', (r) => { if (r.resourceType() !== 'script' && r.resourceType() !== 'stylesheet') console.log('REQ', r.method(), r.resourceType(), r.url().slice(0, 90)); });
  const check = (n: string, ok: boolean, detail?: string) => { results.push([n, ok, detail]); };
  let crashed = false;
  try {
    await body({ browser, page, check });
  } catch (err) {
    crashed = true;
    const alert = await page.locator(`${ALERT}, [role=status]`).allTextContents().catch(() => []);
    const main = ((await page.locator('main').textContent({ timeout: 2000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ');
    console.log(`ERROR  ${name}: ${(err as Error).message.split('\n')[0]}`);
    console.log(`  url=${page.url()}  alerts=${JSON.stringify(alert)}\n  main="${main.slice(0, 300)}"`);
  } finally {
    await browser.close();
  }
  for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  [${d.slice(0, 160)}]`}`);
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${name}: ${results.length - failed}/${results.length} passed${crashed ? ' (ABORTED)' : ''}`);
  process.exit(failed || crashed ? 1 : 0);
}
