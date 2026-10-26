import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { TURNSTILE_SCRIPT_URL, fulfillTurnstileFixture } from '../turnstile.mjs';

test('AUTH04 engine cleanup control', async ({ app, screen, browser }) => {
  const unexpected: string[] = [];
  await browser.route('**/*', async route => {
    const url = new URL(route.request.url);
    if (`${url.origin}${url.pathname}` === TURNSTILE_SCRIPT_URL) return await fulfillTurnstileFixture(route);
    if (url.origin === process.env.AUTH_E2E_URL) await route.continue();
    else { unexpected.push(url.origin); await route.abort(); }
  });
  await app.open('/login');
  await expect(screen.getByRole('heading', '欢迎回来')).toBeVisible();
  expect(unexpected).toEqual([]);
});
