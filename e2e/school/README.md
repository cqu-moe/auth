# AUTH-03 school journey

This suite retains AUTH-01 (`e2e@0.21.0`, web `0.15.0`, Miniflare `4.20260521.0`).
It is local platform E2E, not acceptance against the real university or Cloudflare deployment.

## Agreed seams and authoring gate

The ticket/user explicitly approves these seams. Each row names the observable
contract, credible regression, missing stronger coverage, and support boundary.

| Owner | Contract and regression detected | Existing gap and fixture boundary |
| --- | --- | --- |
| Built SPA → Worker → D1/DO → native Container DO → production Python/CDP | Binding must survive reopening and yield an allowed school result; catches wiring, mail, browser protocol and persistence failures | AUTH-01 registers DOs without invoking them; older DO tests replace the browser. Only the external school and mail event transport are substitutes |
| Product recovery triggered by an expired external school session | Business refusal, real Workflow steps/alarms, new login, usable directory and terminal cleanup; catches missing bindings and durable scheduling failures | Existing Workflow unit tests call a helper with fake steps. The observer calls `super.run`, and the assertion reads actual Workflow API status |
| Real private Service Binding RPC → fixed school directory | Caller approval, current term, parsing errors, and permission/binding checks after delayed school completion | Existing RPC tests replace DO fetch. The fixture returns school API input; the actual browser/production parser must produce the result |
| UI/API unbind and strongly authenticated admin ban while school I/O is pending | No stale activation/session resurrection, and subsequent business refusal | Existing race tests use internal browser mocks. The external school holds an actual HTTPS response; neither DO nor Workflow responses are manufactured |
| Consumer bindings reconfiguration on the native platform | A generated Auth user ID reaches only the registered consumer while existing Auth identity, school session and consumer D1 survive; catches replacing full options, losing cumulative bindings, poisoned handles and stale mail pump | The composition smoke owns this lifecycle contract. It reloads real Miniflare after an actual import; no production API, service or storage is replaced |

No production flag/export or authorization change is introduced for tests.
`worker.ts` is a build-only wrapper: the production HTTP handler, DOs, RPC and
Workflow run normally. Its Container subclass disables internet access and adds
a private transport to the external fixture control port. It delegates all
production browser protocol paths to the original Container class. The Workflow
subclass records its actual instance ID and delegates to `super.run`. Separate
evidence D1 tables observe sanitized browser outcomes; they are never read by
the product. The mail adapter invokes the production `handleEmail` with MIME
generated from the external school's actual send action, including the real
recipient issued by Auth. Local simulation does not prove Cloudflare MX SPF.

The fixture image derives from the current production Dockerfile without
replacing browser/server modules. School HTTPS keeps the production hostnames;
`/etc/hosts` maps them to loopback, and Chrome trusts only the fixture's generated
certificate SPKI. No global TLS bypass, LOGIN_NODE, browser/Workflow mock or
seeded binding/session/proof is used. The local platform Container has
`enableInternet=false`; unexpected Worker/browser egress is a test failure.

## Runtime capability evidence

`node e2e/school/workflow-probe.mjs` exercises the fixed Miniflare 4 runtime with
actual Workflow creation and step execution writing D1, twice from empty state.
Both runs passed on 2026-10-15. No Miniflare upgrade is necessary. See
[Cloudflare local containers](https://developers.cloudflare.com/containers/guides/local-dev/)
and [local Workflows](https://developers.cloudflare.com/workflows/build/local-development/).

## Execution and consumer support

Install/build as documented in `e2e/README.md`. The school runner additionally
needs a local Docker engine and the production browser base image:

```sh
node e2e/school/build.mjs
node e2e/school/run.mjs
```

Finish the frontend build before starting any runtime, and do not rebuild its
assets while a browser journey is running: Miniflare snapshots the asset map.

`startSchoolAuth({expectedCommit})` from `runtime.mjs` is a Node-only consumer
interface. Pin the Auth commit, call `prepare({email,password})` for a verified
synthetic central identity, then perform real application login and wizard
binding. `prepare` only grants the fixture's legitimate `calendar.external`
prerequisite; it never manufactures a successful binding. The returned
`schoolOrigin` is privileged fixture control for the test process, never an
application/browser URL. `school.py` owns synthetic identity `20990001` and the
school response contract. Passwords/codes/cookies must never be printed.

Consumers can instead import `prepareSchoolBinding(runtime, {email,password})`
from `prepare-binding.mjs` when school binding is a prerequisite of their own
journey. It signs in through the real central API, creates the real address,
submits school credentials through the public API, waits for actual CDP/mail
login, and reads the active binding back. It then signs out its preparation
session and returns only synthetic identity information. The consuming journey
must perform its own real login/OAuth; never inject preparation cookies. Run
`node e2e/school/consumer-smoke.mjs` to verify this contract in two fresh runtimes,
including an independent login, allowed RPC business result and unbind readback.

### Composing the consuming repository

Run the Node support with the pinned Auth checkout as its working directory;
compile the consuming repository's production Worker first and pass its real
Miniflare Worker options to `startSchoolAuth`. `workers` accepts an array or a
synchronous factory receiving `{authOrigin, authWorkerName}`. Bind the consumer's
`AUTH` to `{name: authWorkerName, entrypoint: 'AuthService'}`. `authOrigin` uses the
shared runtime's application hostname; never derive it from an IP literal.

```js
const runtime = await startSchoolAuth({
  expectedCommit: AUTH_PIN,
  workers: ({authOrigin, authWorkerName}) => [{
    name: 'schedule', modules: compiledProductionModules,
    compatibilityDate: '2026-05-01',
    serviceBindings: {AUTH: {name: authWorkerName, entrypoint: 'AuthService'}},
    bindings: {...syntheticScheduleBindings, AUTH_BASE_URL: authOrigin},
    d1Databases: {DB: 'isolated-schedule-db'},
  }],
  fixtureDirectory: absoluteConsumerFixtureDirectory, // contains school.py
});
const schedule = await runtime.getWorker('schedule');
const scheduleDb = await runtime.getD1Database('DB', 'schedule');
// Migrate/prepare the consumer's own prerequisites; run its real HTTP journey.
// Always await runtime.close() in finally.
```

These are Node-only composition/lifecycle options; production exports, RPC
approval and authorization remain unchanged. Names must be unique and cannot
replace the Auth or private fixture Worker. Consumer workers and their own D1s
live inside this runtime's isolated platform state. The consumer supplies its
compiled code, actual bindings/assets/DO declarations/migrations and application
HTTP adapter. The privileged `/directory` control is only an Auth assertion;
it is not evidence that a consuming application ran.

When the consumer needs the real generated Auth ID, finish preparing its school
identity before updating that consumer's bindings:

```js
const account = await prepareSchoolBinding(runtime, {email, password});
await runtime.updateConsumerBindings('schedule-e2e', {
  EXTERNAL_DIRECTORY_USER_ID: account.userId,
});
const schedule = await runtime.getWorker('schedule-e2e');
const scheduleDb = await runtime.getD1Database('DB', 'schedule-e2e');
```

This Node-only method accepts only worker names registered through `workers` at
startup. It merges the supplied plain bindings into that worker's current
bindings and passes the captured full configuration to native `mf.setOptions`;
worker code, service bindings, assets, D1/DO/Workflow declarations and persistence
paths remain intact. Reconfiguration restarts workerd and invalidates previous
Miniflare handles: reacquire consumer Worker/D1 handles afterward. The support
refreshes its own Auth D1, private caller and evidence handles and pauses its mail
pump during reload. Call it serially between completed requests, before starting
the consumer journey; do not reconfigure during a running school login, Workflow
or browser request. It preserves persisted state, not in-flight requests or live
container processes, and exposes no production API or binding override.

`consumer-smoke.mjs` adds a separate actual Worker, forwards a real independently
created login cookie to the production Auth HTTP service, calls the actual
`AuthService`, imports the returned course into its own D1 and reads that row
back. It also checks refusal after unbind. This is a composition transport probe,
not Schedule's production business acceptance. Its two runs supply a different
external `school.py` and require its changed course name, proving fixture input
reaches the real browser/parser rather than only the Node test process.
The probe additionally holds actual school mail after address selection, unbinds,
then releases it: the production handler must reject the obsolete address. The
pump permits only that specific refusal after re-reading D1; rejection of a
current address, malformed mail and transport errors still fail the run.

`fixtureDirectory` is a Docker named build context containing the external
`school.py`; the production container/server/CDP code and fixture TLS wrapper
remain the same. Extend that file for personal curriculum/my-table/exam APIs in
SCHEDULE-01. Those APIs are not implemented or claimed here. Preserve HTTPS
school hosts/port 443, `/fixture/{cert.pem,key.pem}`, and the control server on
9090 with `/control` (GET/POST mode/session/hold/expiry/events and actual
profiles/chromeProcesses) plus `/mail` (drain generated `{code}` messages).
`holdMail` is an optional control used by the support's delayed-mail regression.
The image's cleanup evidence includes the SHA256 of the supplied school file.

Cleanup also owns workerd's separate egress proxy containers. Their names are
recorded from the actual per-run Durable Object IDs before fixture dispatch,
and captured from the unique business image before Miniflare disposal as well
as at final cleanup. This covers production starts that never reached a fixture
control call. Their image is checked before removal. Both business and proxy
object IDs must be absent after shutdown; scanning only the fixture image misses these proxies.
The evidence reports `proxyObjectsRemoved` and the removed proxy IDs. Earlier
reports without this field prove fixture cleanup only, not interceptor cleanup.
Never put an Auth/browser/Workflow replacement into that external fixture.

The private caller proves Auth's actual RPC transport; consuming repositories
still own their application-side business assertions. `close()` must run in
`finally`, and cleanup failures must fail the caller. Each run has a unique
image, D1/DO/Workflow directory, port and browser profile. Evidence belongs in
`.e2e/`; never upload runtime databases, raw MIME or container logs.

## Acceptance and regression evidence

The nine required scenarios cover binding/reopen/business result, real session
expiry and Workflow recovery, protected admin-class POST and course/instructor
parsing, before/after current-term checks, rejected caller/transport controls,
delayed entitlement, ban and binding revocation, school password rejection, send
failure, actual 60-second send timeout, wrong mail code, cancellation and ban
while an actual school response is outstanding. All normal actions use the SPA
or production HTTP/admin APIs. Only initial roles, client approval and business
entitlements are prerequisite fixtures. No user/session/security proof or
binding success is inserted.

The ban regression returned HTTP 200 on the baseline after the administrator
had banned the user. The owner now rechecks the existing ban semantics in the
DO capability checkpoint, and both conditional D1 activation statements reject
an active ban. Maintenance cleanup still runs while a user is banned; browser
work stops at its later capability checkpoint. Expired bans retain their
existing meaning. The same real-container test requires a failure, unbans and
logs in again, then confirms the old task did not leave an authorized binding.
The delayed-directory guard regression is also exercised with an actual held
school response: with the new owner-ban checkpoint reverted, it returned course
data after the administrator's ban; with the checkpoint it must return
`SESSION_INACTIVE`, and subsequent calls remain `FORBIDDEN`. Unban preserves a
previously active binding, matching the existing authorization model.
Separate real recovery Workflows also hold their school's ticket response while
unbind or ban runs, then require terminal recovery with durable cleanup and no
successful late publication. Unbind removes the cycle (a completed no-op);
ban terminates the existing cycle as failed instead of leaving it running until
the 30-minute deadline. A cycle may span initial binding and later recovery, so
the assertion follows the actual running instance instead of assuming a new ID.
A prior active binding can legitimately
recover again after unban; the test does not turn ban into permanent revocation.

The runner records the actual Workflow API terminal outputs, sanitized container
outcomes, zero remaining school rows after each scenario's unbind, zero live
Chromium processes/profiles, removal of the run directory and removal of its
Docker instances/image. A unique image-config label prevents concurrent runs
with identical cached layers from sharing Docker ancestor identity. Source
fingerprints must match before/after execution. Pinned consumer runs require a
clean checkout. Cleanup, startup, wrong pin, zero tests, skipped/interrupted
tests, unexpected Worker/SPA egress and secret leakage all fail the command.

`node e2e/school/self-check.mjs` requires inner exit 1 for a deliberately wrong
pre-secret page assertion (including screenshot/report), zero selection and a
wrong commit. Failures after Secret fills retain sanitized text traces and
observations; the framework's screenshot suppression remains enabled. The CI
aggregate requires the school job, two complete fresh invocations, consumer
smoke and negative controls. Remote CI is distinct from local equivalent runs.

The self-check accepts only the exact mobile school-binding test's single
`ASSERTION_FAILED` at the deliberately wrong pre-secret heading, with no run,
secondary, artifact or cleanup errors. Zero selection must retain the actual
`NO_TESTS` collection error and no executed tests; wrong pin must fail with the
exact commit-mismatch error before allocating resources. A different failing
journey or startup error is not a successful negative control. The final
`controls.json` receipt is written only after all three checks pass.
