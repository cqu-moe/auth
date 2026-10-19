import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
assert(process.env.POSTHOG_CLI_API_KEY, 'POSTHOG_CLI_API_KEY is required for release source maps');
assert.equal(process.env.POSTHOG_CLI_PROJECT_ID, '662666', 'Auth source maps must target PostHog project 662666');
assert(dryRun || process.env.POSTHOG_CLI_DRY_RUN !== 'true', 'A release must upload its source maps');
const release = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
process.env.VITE_RELEASE = release;
process.env.POSTHOG_CLI_HOST = 'https://us.posthog.com';
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

run('npm', ['--prefix', 'frontend', 'run', 'build']);
assert(!readdirSync('frontend/dist/assets').some(name => name.endsWith('.map')), 'Source maps must not be public assets');
rmSync('dist-worker', { recursive: true, force: true });
run('node_modules/.bin/wrangler', ['deploy', '--dry-run', '--outdir', 'dist-worker', '--upload-source-maps']);
run('node_modules/.bin/posthog-cli', ['sourcemap', 'process', '--directory', 'dist-worker', '--release-name', 'auth-worker', '--release-version', release, '--release-mode', 'symbol-set']);
assert(readFileSync('dist-worker/index.js', 'utf8').includes('chunkId='), 'Deploy only the source-map-injected Worker');
run('node_modules/.bin/wrangler', ['deploy', 'dist-worker/index.js', '--no-bundle', '--upload-source-maps', '--experimental-provision=false', '--keep-vars', '--var', `QUICKLOGIN_SERVER_BUILD:${release}`, '--var', `RELEASE:${release}`, ...(dryRun ? ['--dry-run'] : [])]);
