import { describe, expect, it } from 'vitest';
import { LOGIN_INVALID, LOGIN_SERVER, LOGIN_UNCONFIRMED, lockoutMessage, loginOutcome } from '../src/web/login';

describe('login messages', () => {
  it('wrong password and unknown email read the same; a closing failure announces the lock', () => {
    expect(loginOutcome({ status: 400, code: 'invalid_credentials' }, 0).message).toBe(LOGIN_INVALID);
    expect(loginOutcome({ status: 400, code: 'invalid_credentials' }, 300).message)
      .toBe('Demasiados intentos fallidos. Por seguridad, podrás intentarlo nuevamente en 5 minutos.');
  });
  it('unconfirmed email is named (Supabase only says so after the password matched)', () => {
    expect(loginOutcome({ status: 400, code: 'email_not_confirmed' }, 0).message).toBe(LOGIN_UNCONFIRMED);
  });
  it('server or provider errors never show technical text', () => {
    const o = loginOutcome({ status: 500, code: 'unexpected_failure' }, 0);
    expect(o.message).toBe(LOGIN_SERVER);
    expect(o.diagnostic).toEqual({ event: 'login_failed', status: 500, code: 'unexpected_failure' });
    expect(loginOutcome({ status: 429, code: 'over_request_rate_limit' }, 0).message).toBe(LOGIN_SERVER);
  });
  it('lock minutes round up, singular for 1', () => {
    expect(lockoutMessage(899)).toContain('15 minutos');
    expect(lockoutMessage(30)).toContain('1 minuto.');
  });
});
