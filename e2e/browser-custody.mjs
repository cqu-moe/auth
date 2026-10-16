import { access, mkdtemp, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function selectedBrowser() {
  const name = process.env.AUTH_E2E_BROWSER || 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(name)) throw new Error('Unsupported AUTH_E2E_BROWSER');
  return name;
}

// Cleanup must not replace a child/log/readback failure. Keep the actual Error
// objects (including causes) for the runner's private evidence serializer.
export async function withBrowserCustody(custody, task) {
  let failed = false;
  let primary;
  try { return await task(); }
  catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await custody?.close(); }
    catch (cleanup) {
      if (failed) throw new AggregateError([primary, cleanup], 'Browser operation and custody cleanup failed');
      throw cleanup;
    }
  }
}

// Observe real Playwright-created profiles, then read their absence before
// deleting the owned temporary root. Never accept the root deletion as proof.
export async function observeBrowserProfiles(name) {
  const directory = await mkdtemp(join(tmpdir(), 'auth-browser-'));
  const profiles = new Set();
  return {
    env: { TMPDIR: directory, DEBUG: 'pw:browser' },
    observe() {
      for (const file of readdirSync(directory)) {
        if (file.startsWith(`playwright_${name}dev_profile-`)) profiles.add(join(directory, file));
      }
    },
    async readback(log) {
      const launch = log.split('\n').find(line => line.includes('<launching>')) ?? '';
      const removed = await Promise.all([...profiles].map(path => access(path).then(() => false, error => {
        if (error.code === 'ENOENT') return true;
        throw error;
      })));
      return { headless: /(?:-headless|--headless)(?:[=\s]|$)/.test(launch),
        engine: name === 'firefox' ? /firefox[^\s]* -no-remote/.test(launch) : launch.includes('pw_run.sh'),
        temporaryProfile: profiles.size > 0, profileRemoved: removed.length > 0 && removed.every(Boolean) };
    },
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
}
