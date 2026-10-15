# Local built Auth lifecycle

AUTH-01 / https://github.com/cqu-moe/auth/issues/79. These are deterministic PR tests, not production or school acceptance.

## Run

Use Node 22.22.3 and the existing frontend pnpm 11.19.0 lockfile. Install root dependencies with `npm ci`, frontend dependencies with `pnpm --dir frontend install --frozen-lockfile`, and the pinned engine browser with `npx --no-install e2e-web install chromium` (CI adds `--with-deps`).

Run `npm run test:e2e`. It typechecks the tests, builds the real SPA with browser telemetry disabled, then uses the actual Worker entry bundled by Wrangler in a separate build-only configuration. It never reads a developer `.dev.vars` or starts a production binding. Miniflare/workerd uses the repository's original runtime version, real D1 and all repository SQL migrations. Assets are the built SPA served by Miniflare's assets service. CQU/QuickLogin DO classes are registered but their school, container and Workflow behavior is **not** covered by this ticket.

Each invocation runs desktop and 390×844 independently, using a fresh OS-selected loopback port, SQLite directory and browser context. Workers may call only the captured Resend email endpoint; browser requests may only use the current Auth origin. Unexpected egress is denied and fails the invocation. No actual message, school request or AI/model call is made. Both framework `E2E_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1` and Wrangler telemetry opt-out are explicit in the runner and CI; the browser build has no PostHog token.

The two tests exercise real signup, required/optional invitation policy, invalid/expired/used invitations, duplicate signup, wrong verification code, verification, protected UI gating, allowed/malicious return targets, reload persistence, logout/401 and wrong-password rejection followed by successful login. Fixture rows only prepare registration settings and invitations; no user, verification result or session is seeded. Email OTPs originate in the app and cross only the external mail delivery adapter.

`node e2e/self-check.mjs` deliberately breaks a registration-page business assertion **before** filling secrets. The inner command must fail with exactly one failed test and leave a screenshot/report; the outer self-check passes only after verifying this and successful cleanup. After a Secret fill, e2e intentionally disables screenshots for the remainder of that attempt. We retain redacted step/screen text and logs for those failures rather than bypassing that protection. Negative-control output remains separate from normal output. `node e2e/account-smoke.mjs` verifies the downstream account API described below.

Every run retains `.e2e/run-<time>/{desktop,mobile}/report.json`, `runner.log`, and `runtime.json`; failures also retain the framework trace and permitted screenshots. No retries are enabled. Zero tests, skipped/interrupted required cases, egress, secret leakage in text artifacts, startup and cleanup failures fail the command. Cleanup stops workerd and the mail control server and removes the run's SQLite/bundle directory. Never publish a runtime DB or mail payload. Public CI uploads only `.e2e/` synthetic reports.

## Downstream fixed-commit interface

Consumers must check out a specific Auth commit (the integration merge owner records the final ticket commit), install its lockfiles and build its frontend. Never track moving `main`. The API is ESM, run with this Auth checkout as the process working directory:

- `startAuth({ expectedCommit })` from `e2e/runtime.mjs` checks the exact current commit before creating state. It resolves only after the actual Worker, migrated DB, assets and external mail adapter are available.
- Returned `origin` is the real local Auth HTTP origin; configure the consuming application to use it. `controlOrigin` is a privileged **test-process-only** loopback mail/config adapter, never a browser or production endpoint. Do not proxy it through applications.
- `prepareAccount(runtime, { email, password, name })` from `e2e/prepare-account.mjs` accepts only synthetic `@example.test` identities, seeds an unused invitation, then performs real HTTP signup, consumes the actual app-generated mail OTP and verifies the account. It reads back the verified identity and returns `{ email, password, userId }`. It deliberately discards the preparation session; downstream must exercise real login/OAuth rather than inject a session or token. Do not print the returned password.
- `runtime.db` is the isolated D1 handle, only for legitimate prerequisite setup such as a consumer's OAuth registration; it must not seed the success being tested. OAuth client setup/complete cross-app grants are owned by later tickets, not claimed here.
- Always `await runtime.close()` in `finally`; errors are failures. It removes the database, stops local services and rejects unexpected Worker egress. Per-consumer browser isolation and egress blocking remain the consumer's responsibility.
- `AUTH_E2E_EXPECT_COMMIT` applies the same pin to the runner. `AUTH_E2E_OUTPUT` must be a child of `.e2e`; `AUTH_E2E_MOBILE=1` runs only the phone viewport. Default runner executes both with separate runtime state.

School binding, queue/recovery workflow, OAuth grant/revocation, TOTP/Passkey and live test accounts remain the other tickets' responsibilities. This helper does not claim they work. The official CI aggregate requires the new browser job as well as the original application/container jobs; remote CI results must be reported separately from local execution.
