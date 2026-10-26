import { randomUUID } from 'node:crypto';

export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token';
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
export const TURNSTILE_SECRET = 'synthetic-e2e-turnstile-secret';

const actions = new Map([
  ['/auth/sign-up/email', 'signup'],
  ['/auth/sign-in/email', 'password-login'],
  ['/auth/request-password-reset', 'password-reset'],
  ['/auth/email-otp/send-verification-otp', 'email-verification'],
  ['/auth/send-verification-email', 'email-verification'],
  ['/auth/email-otp/request-email-change', 'email-change'],
]);

export function turnstileAction(path) {
  const pathname = new URL(path, 'http://e2e.invalid').pathname.replace(/^\/api\/v1(?=\/)/, '');
  return actions.get(pathname) ?? null;
}

export function encodeTurnstileToken(action, hostname) {
  return `e2e.${Buffer.from(JSON.stringify({ action, hostname, nonce: randomUUID() })).toString('base64url')}`;
}

export function parseTurnstileToken(token) {
  if (typeof token !== 'string' || !token.startsWith('e2e.')) return null;
  try {
    const value = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
    if (typeof value?.action !== 'string' || typeof value?.hostname !== 'string' || typeof value?.nonce !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

export function turnstileHeaders(path, origin = process.env.AUTH_E2E_URL) {
  const action = turnstileAction(path);
  return action ? { [TURNSTILE_TOKEN_HEADER]: encodeTurnstileToken(action, new URL(origin).hostname) } : {};
}

export const turnstileFixtureScript = `
(() => {
  const widgets = new Map();
  let serial = 0;
  const setting = name => globalThis[name] ?? JSON.parse(globalThis.localStorage?.getItem(name) ?? 'null');
  globalThis.turnstile = {
    ready(callback) { Promise.resolve().then(callback); },
    render(container, options) {
      const id = 'e2e-turnstile-' + ++serial;
      const delay = Math.max(Number(setting('__E2E_TURNSTILE_DELAY__') ?? 0), 0);
      const shouldFail = Number(setting('__E2E_TURNSTILE_FAILURES__') ?? 0) > 0;
      if (shouldFail) localStorage.setItem('__E2E_TURNSTILE_FAILURES__', String(Number(setting('__E2E_TURNSTILE_FAILURES__')) - 1));
      const timer = setTimeout(() => {
        if (!widgets.has(id)) return;
        if (shouldFail) options['error-callback']?.();
        else {
          container.dataset.turnstileResult = 'ready';
          options.callback('e2e.' + btoa(JSON.stringify({
            action: options.action,
            hostname: location.hostname,
            nonce: crypto.randomUUID(),
          })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
        }
      }, delay);
      widgets.set(id, timer);
      return id;
    },
    remove(id) {
      clearTimeout(widgets.get(id));
      widgets.delete(id);
    },
  };
})();
`;

export function fulfillTurnstileFixture(route) {
  return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: turnstileFixtureScript });
}
