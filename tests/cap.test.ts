import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_INVALID } from '../src/web/login';
import { capSecret, capSecretInfo, newChallenge, redeem, signRedeemToken, verifyCapToken, type Spend } from '../lib/cap-core';

/**
 * Cap anti-bot (lib/cap-core.ts): the real capjs-core with small proof-of-work parameters, solved here like the
 * browser widget does (sha256(salt + nonce) starts with the target), and an in-memory single-use store.
 */
const SECRET = 'test-secret-0123456789-abcdefghij-XYZ';
const SMALL = { challengeCount: 3, challengeSize: 16, challengeDifficulty: 2 };

function fnv1a(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); }
  return h >>> 0;
}
function prng(seed: string, length: number) {
  let state = fnv1a(seed); let out = '';
  while (out.length < length) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; out += state.toString(16).padStart(8, '0'); }
  return out.slice(0, length);
}
/** What the widget computes in its workers. */
function solve(token: string, c: { c: number; s: number; d: number }): number[] {
  return Array.from({ length: c.c }, (_, i) => {
    const salt = prng(`${token}${i + 1}`, c.s); const target = prng(`${token}${i + 1}d`, c.d);
    for (let n = 0; ; n++) if (createHash('sha256').update(salt + n).digest('hex').startsWith(target)) return n;
  });
}
function memoryStore(): Spend & { keys: Set<string> } {
  const keys = new Set<string>();
  const spend = Object.assign(async (key: string) => { if (keys.has(key)) return false; keys.add(key); return true; }, { keys });
  return spend;
}
async function solvedToken(scope: 'login' | 'signup' | 'recovery', spend: Spend) {
  const ch = await newChallenge(SECRET, scope, SMALL);
  const r = await redeem(SECRET, scope, { token: ch.token, solutions: solve(ch.token, ch.challenge) }, spend);
  if (!r.success) throw new Error(r.reason);
  return r.token;
}

describe('Cap: challenge → redeem (server side of the widget)', () => {
  it('a valid solution returns a redeem token; the same solved challenge cannot be redeemed twice', async () => {
    const spend = memoryStore();
    const ch = await newChallenge(SECRET, 'login', SMALL);
    const body = { token: ch.token, solutions: solve(ch.token, ch.challenge) };
    const first = await redeem(SECRET, 'login', body, spend);
    expect(first.success).toBe(true);
    expect(await redeem(SECRET, 'login', body, spend)).toEqual({ success: false, reason: 'already_redeemed' });
  });
  it('wrong solutions, a foreign or tampered challenge, another scope and junk bodies are refused', async () => {
    const spend = memoryStore();
    const ch = await newChallenge(SECRET, 'login', SMALL);
    const good = solve(ch.token, ch.challenge);
    expect((await redeem(SECRET, 'login', { token: ch.token, solutions: good.map((n) => n + 1) }, spend)).success).toBe(false);
    const foreign = await newChallenge('another-secret-0123456789-abcdefgh', 'login', SMALL);
    expect(await redeem(SECRET, 'login', { token: foreign.token, solutions: solve(foreign.token, foreign.challenge) }, spend)).toEqual({ success: false, reason: 'invalid_token' });
    expect(await redeem(SECRET, 'signup', { token: ch.token, solutions: good }, spend)).toEqual({ success: false, reason: 'scope_mismatch' });
    for (const junk of [null, 'x', {}, { token: ch.token }, { token: ch.token, solutions: ['1', '2', '3'] }, { token: ch.token, solutions: new Array(2000).fill(1) }]) {
      expect((await redeem(SECRET, 'login', junk, spend)).success).toBe(false);
    }
    expect(spend.keys.size).toBe(0); // nothing spent for refused attempts
  });
  it('an expired challenge is refused', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const ch = await newChallenge(SECRET, 'login', SMALL);
      const solutions = solve(ch.token, ch.challenge);
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
      expect(await redeem(SECRET, 'login', { token: ch.token, solutions }, memoryStore())).toEqual({ success: false, reason: 'expired' });
    } finally { vi.useRealTimers(); }
  });
});

describe('Cap: the token checked inside the protected action', () => {
  it('valid token passes once; reused → refused', async () => {
    const spend = memoryStore();
    const token = await solvedToken('login', spend);
    expect(await verifyCapToken(SECRET, 'login', token, spend)).toEqual({ ok: true });
    expect(await verifyCapToken(SECRET, 'login', token, spend)).toEqual({ ok: false, reason: 'replayed' });
  });
  it('missing, malformed, tampered, other scope, expired, unconfigured, store down → refused (fail closed)', async () => {
    const spend = memoryStore();
    const token = await solvedToken('signup', spend);
    expect(await verifyCapToken(SECRET, 'signup', null, spend)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyCapToken(SECRET, 'signup', '', spend)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyCapToken(SECRET, 'signup', 'abc:def', spend)).toEqual({ ok: false, reason: 'malformed' });
    const tampered = token.replace(/\.(\d{13})\./, (_, e) => `.${Number(e) + 1}.`);
    expect(await verifyCapToken(SECRET, 'signup', tampered, spend)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyCapToken('another-secret-0123456789-abcdefgh', 'signup', token, spend)).toEqual({ ok: false, reason: 'bad_signature' });
    // A token minted for signup cannot open login (scope is inside the signature).
    expect(await verifyCapToken(SECRET, 'login', token.replace('v1.signup.', 'v1.login.'), spend)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyCapToken(SECRET, 'login', token, spend)).toEqual({ ok: false, reason: 'scope' });
    const old = signRedeemToken(SECRET, 'signup', Date.now() - 1);
    expect(await verifyCapToken(SECRET, 'signup', old, spend)).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyCapToken(null, 'signup', token, spend)).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await verifyCapToken(SECRET, 'signup', token, async () => { throw new Error('db down'); })).toEqual({ ok: false, reason: 'store_error' });
  });
  it('the secret comes only from server env: CAP_SECRET (trimmed, >= 16), else derived from another server secret, else none', () => {
    expect(capSecret({})).toBeNull();
    expect(capSecret({ CAP_SECRET: 'short' })).toBeNull();
    expect(capSecret({ NEXT_PUBLIC_CAP_SECRET: SECRET, NEXT_PUBLIC_GEMINI_API_KEY: SECRET })).toBeNull();
    expect(capSecret({ CAP_SECRET: SECRET })).toBe(SECRET);
    expect(capSecret({ CAP_SECRET: `  ${SECRET}\n` })).toBe(SECRET);
    expect(capSecret({ CAP_SECRET: '0123456789abcdef' })).toBe('0123456789abcdef');
    const derived = capSecretInfo({ GEMINI_API_KEY: 'AIza-test-key-0123456789' });
    expect(derived.source).toBe('derived');
    expect(derived.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(derived.secret).not.toContain('AIza');
    expect(capSecretInfo({ CAP_SECRET: SECRET, GEMINI_API_KEY: 'AIza-test-key-0123456789' }).source).toBe('cap_secret');
  });
  it('a derived secret signs and verifies exactly like CAP_SECRET (Cap still on)', async () => {
    const secret = capSecret({ GEMINI_API_KEY: 'AIza-test-key-0123456789' })!;
    const spend = memoryStore();
    const ch = await newChallenge(secret, 'login', SMALL);
    const r = await redeem(secret, 'login', { token: ch.token, solutions: solve(ch.token, ch.challenge) }, spend);
    expect(r.success).toBe(true);
    expect(await verifyCapToken(secret, 'login', (r as { token: string }).token, spend)).toEqual({ ok: true });
    expect(await verifyCapToken(SECRET, 'login', (r as { token: string }).token, memoryStore())).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

// ── The real auth actions with Next.js and Supabase stubbed: Cap first, then the existing lockout ───────────────
const rpc = vi.fn();
const auth = { signInWithPassword: vi.fn(), signInWithOtp: vi.fn(), resetPasswordForEmail: vi.fn() };
const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT'); });
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: (...a: unknown[]) => (redirect as (...x: unknown[]) => never)(...a) }));
vi.mock('../lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({ rpc, auth }), authUser: async () => null }));

describe('auth actions behind Cap', () => {
  let store: ReturnType<typeof memoryStore>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.CAP_SECRET = SECRET;
    store = memoryStore();
    rpc.mockReset(); redirect.mockClear();
    for (const f of Object.values(auth)) f.mockReset();
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'cap_spend') return { data: await store(args.p_key as string, args.p_ttl_seconds as number), error: null };
      if (name === 'login_attempt') return { data: [{ allowed: true, wait_seconds: 0 }], error: null };
      return { data: null, error: null };
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); delete process.env.CAP_SECRET; });

  const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const called = (name: string) => rpc.mock.calls.filter((c) => c[0] === name).length;

  it('login: no token → refused before the lockout counter and Supabase Auth; valid token → continues', async () => {
    const { login } = await import('../app/auth/actions');
    expect(await login({}, form({ email: 'ana@test.local', password: 'x' }))).toEqual({ error: 'No pudimos verificarte. Intenta otra vez.' });
    expect(called('login_attempt')).toBe(0);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();

    auth.signInWithPassword.mockResolvedValueOnce({ error: { status: 400, code: 'invalid_credentials' } });
    const token = await solvedToken('login', store);
    const r = await login({}, form({ email: 'ana@test.local', password: 'x', 'cap-token': token }));
    expect(r.error).toBe(LOGIN_INVALID);
    expect(called('login_attempt')).toBe(1); // the existing lockout still counts every verified attempt

    // The same token again (replay) is refused; the lockout is not reached.
    expect(await login({}, form({ email: 'ana@test.local', password: 'x', 'cap-token': token }))).toEqual({ error: 'No pudimos verificarte. Intenta otra vez.' });
    expect(called('login_attempt')).toBe(1);
  });

  it('login: the lockout still blocks a verified attempt', async () => {
    const { login } = await import('../app/auth/actions');
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      name === 'cap_spend' ? { data: await store(args.p_key as string, 600), error: null } : { data: [{ allowed: false, wait_seconds: 300 }], error: null });
    const r = await login({}, form({ email: 'ana@test.local', password: 'x', 'cap-token': await solvedToken('login', store) }));
    expect(r.error).toContain('5 minutos');
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('signup and recovery: refused without a token, work with one; a login token does not open signup', async () => {
    const { signup, requestPasswordReset } = await import('../app/auth/actions');
    expect(await signup({}, form({ email: 'new@test.local' }))).toEqual({ error: 'No pudimos verificarte. Intenta otra vez.' });
    expect(await signup({}, form({ email: 'new@test.local', 'cap-token': await solvedToken('login', store) }))).toEqual({ error: 'No pudimos verificarte. Intenta otra vez.' });
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
    auth.signInWithOtp.mockResolvedValueOnce({ error: null });
    expect((await signup({}, form({ email: 'new@test.local', 'cap-token': await solvedToken('signup', store) }))).sent).toBe(true);

    expect(await requestPasswordReset({}, form({ email: 'ana@test.local' }))).toEqual({ error: 'No pudimos verificarte. Intenta otra vez.' });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
    auth.resetPasswordForEmail.mockResolvedValueOnce({ error: null });
    expect((await requestPasswordReset({}, form({ email: 'ana@test.local', 'cap-token': await solvedToken('recovery', store) }))).message).toBeTruthy();
  });

  it('CAP_SECRET missing → every protected action refuses (fail closed); logs carry no token', async () => {
    delete process.env.CAP_SECRET;
    const { login } = await import('../app/auth/actions');
    const token = signRedeemToken(SECRET, 'login', Date.now() + 60_000);
    expect(await login({}, form({ email: 'ana@test.local', password: 'x', 'cap-token': token }))).toEqual({ error: 'No pudimos verificarte. Intenta otra vez.' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
    expect(JSON.stringify(warn.mock.calls)).toContain('unconfigured');
  });
});
