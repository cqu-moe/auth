# Issue #104 validation — 2026-10-26

Source: [#104](https://github.com/cqu-moe/auth/issues/104). Auth baseline:
`b2089761019907241dcbc029e036deea77f42352` (the original audit used `b1791e1`).
Checks used disposable local accounts, local D1 and HTTPS, and read-only deployment
queries. No production account attack, email delivery, queue enqueue, school
request, load test, or deployment was performed.

| Candidate | Verdict | Result |
| --- | --- | --- |
| Sibling-origin binding CSRF | **confirmed in controlled browser; fixed** | A sibling form sent the host-only Lax cookie and created one pending binding; now returns 403 without a binding. |
| OAuth consent clickjacking | **confirmed in controlled browser; fixed** | A same-site sibling frame could complete consent. Both same-site and cross-site frames are now blocked. Production application headers also lacked frame isolation at observation time. |
| Queue producer content trust | **rejected as an application privilege escalation in the inspected deployment** | The deployed producer's authorization/rendering chain and the account's members, token policies and OAuth grants were inspected. Other direct publishers already have account-wide Worker administration. A separate transient-idempotency acknowledgement bug was confirmed and fixed. |
| Cross-user RPC client quota | **rejected as a violation of the current service-identity contract** | Independent user buckets are intentional; the approved client currently reaches two eligible users. Capacity, account limits, aggregate usage and billing were inspected. This does not provide a global client budget or prove resistance to abuse by an approved service. |

The first two results establish behavior under a controlled compromised-sibling
scenario, which is within [ADR 0002's isolation model](../adr/0002-first-party-session-isolation.md).
They do not establish an actual compromised production sibling or a production
account exploit. The remaining two candidates do not establish an additional
privilege escalation under the current service/administration trust model. Their
deployment validation is complete within the limits below; #104 remains open
until the fixes are released. Administrative credential isolation and a future
global client budget would be separate policy changes.

## Binding creation

The [binding route](../../src/routes/cqu-bind.ts) previously authenticated the
session and accepted an empty form body through `optionalEmpty`, without checking
Origin. [Cookie isolation](../../src/services/auth-cookies.ts) uses host-only,
Secure, HttpOnly, `SameSite=Lax` cookies. That does not prevent same-site requests
from a sibling to the Auth host.

The isolated Chromium check used HTTPS `auth.cqu.localhost` and
`sibling.cqu.localhost` on a loopback server, the real built SPA/Worker, a verified
synthetic identity and local D1. Browser request headers were preserved by an HTTP
proxy; Worker and browser egress were restricted to the fixtures. Observations:

| Observation | Baseline | Fixed |
| --- | --- | --- |
| Session cookie attributes | host-only / Secure / HttpOnly / Lax | unchanged |
| Empty sibling form Origin / Fetch Metadata | sibling origin / `same-site` | unchanged |
| Session cookie sent | yes | yes |
| POST result / pending binding count | 201 / 1 | 403 / 0 |
| Legitimate same-origin empty POST | accepted | 201 |

The fix checks the exact configured Auth Origin before parsing or writing. Missing
Origin, literal `null`, sibling and unrelated origins are denied. Empty same-origin
POST compatibility and idempotency remain. The real Workers-pool regression in
[cqu-binding-api.test.ts](../../test/do/cqu-binding-api.test.ts) failed before the
fix (`expected 403, received 201`) and passed afterwards. OpenAPI now declares the
runtime Origin restriction and 403 response; generated types were refreshed.

## Consent framing

On 2026-10-26, command-line GET first received a Cloudflare **403 challenge**, whose
`X-Frame-Options: SAMEORIGIN` is not application evidence. A subsequent normal
ego-browser navigation and same-origin fetch returned **200 `text/html`** for
`https://auth.cqu.moe/oauth/authorize`, with neither `Content-Security-Policy` nor
`X-Frame-Options`. No production frame or consent action was attempted.

The local browser check used a seeded dummy OAuth client and the real provider's
PKCE authorization/consent flow:

| Frame | Baseline cookie / behavior | Fixed behavior |
| --- | --- | --- |
| `cross.other.localhost` (cross-site) | No session cookie; redirected to login | Browser blocked the framed document |
| `sibling.cqu.localhost` (same-site) | Session cookie sent; controlled consent click returned an authorization code to the local callback | Browser blocked the framed document; no callback code |

[ASSETS fallback](../../src/app.ts) now appends CSP `frame-ancestors 'none'` and sets
`X-Frame-Options: DENY`. Existing CSP policies are preserved. API/discovery routing
and error handling are unchanged. [Routing tests](../../src/app.test.ts) failed
on the missing header before the fix and passed afterwards. The fixed browser
check also completed a fresh top-level authorization successfully.

## Schedule notification trust

`wrangler queues info schedule-notifications` reported one bound Worker producer
(`worker:schedule-beta-cqu-moe`) and one consumer (`worker:cqu-moe-auth`).
[HTTP publishing](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/)
also accepts an account-scoped `Queues Write` credential, so the binding list is
not a complete publisher boundary.

Read-only account API queries and the owner's authenticated dashboard on
2026-10-26 established the following inventory. All token-list pages were read;
token values, secret bindings and API key values were not requested.

| Principal class | Observed authority |
| --- | --- |
| Account membership | One accepted member, with Super Administrator privileges. The owner's sessions/global API-key authority are administrative trust. |
| Account-owned API tokens | Four tokens; none grants `Queues Write` or `Workers Scripts Write`. |
| Owner's user API tokens | 47 tokens. Fourteen active deployment tokens grant account-wide `Queues Write`; all fourteen also grant account-wide `Workers Scripts Write`. Three additional tokens grant Worker script administration without direct Queue-write permission. |
| Connected OAuth applications | Seven grants inspected. Wrangler and one explicitly authorized third-party deployment application grant both Queue-write and Worker-script-write access to this account. The other five have no direct Queue-write permission. A Workers-write grant is also an administrative path, not an isolated message publisher. |

The third-party grant is real: this is **not** a first-party-only publisher
inventory. However, every observed direct publisher outside Schedule already has
authority to replace the Auth/Schedule Worker. No enqueue-only, lower-privilege
principal was found crossing into a stronger application privilege. Signing
messages with another Worker secret would not isolate these administrators.
Credential compromise or reducing deployment/OAuth privileges remains a separate
control-plane concern; no existing token or application authorization was revoked.
Detailed principal identities/policies remain in local evidence rather than this
public report.

The reviewed Schedule source was commit `5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284`:

- [Sync producer](https://github.com/cqu-moe/schedule/blob/5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284/src/cron/schedule-sync.ts#L1018) gates notifications on the owned subscription, persisted opt-in and `calendar.change_notification`; pending batches are persisted and replayed unchanged.
- [Email renderer](https://github.com/cqu-moe/schedule/blob/5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284/src/services/schedule-email.ts#L17) escapes dynamic HTML and builds the subject, body and links from fixed templates and schedule diffs.
- [ID generation](https://github.com/cqu-moe/schedule/blob/5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284/src/services/schedule-notifications.ts#L377) hashes the user and old/new snapshot hashes; split messages receive distinct suffixes.

The active production Schedule version was
`575ad8fc-6c49-466e-912c-6dcb97110a0a`, deployed 2026-10-23T17:19:11Z. Its script
content was downloaded read-only and the same critical gates were reviewed in
the deployed artifact: subscription ownership, entitlement/opt-in, fixed escaped
templates, persisted pending message replay and fixed Queue binding. The downloaded
`index.js` SHA-256 was
`a52e36ffc7f896d2d9c34a2401ba4be6eb2431240362bb2cf0b46e6fb0cfa822`.
Deployment metadata contained no commit annotation; this establishes the reviewed
production code path, not byte-for-byte attribution of the whole bundle to a Git
commit.

The [Auth consumer](../../src/queue/schedule-notifications.ts) rechecks the current
email, verification and entitlement, uses its fixed sender, and trusts admitted
producer content. A local assertion with injected `resolveRecipient/sendEmail`
confirmed that two different bodies with the same ID both reach the injected
sender. This proves the absence of local content binding; it is not a Resend send.

[Resend's documented contract](https://resend.com/docs/dashboard/emails/idempotency-keys)
rejects a reused key with a different payload with `409 invalid_idempotent_request`
within its 24-hour idempotency window. A concurrent request for a key still being
processed instead returns `409 concurrent_idempotent_requests`, which is safe to
retry later. Installed `resend@6.12.3` preserves that error name. These are provider
contract and SDK-source facts, not a live email-delivery observation.

The consumer previously acknowledged both errors. With
[at-least-once Queue delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
a replay can encounter an unfinished earlier request; acknowledging the replay
before that request's final outcome can lose a notification. The consumer now
retries the exact `concurrent_idempotent_requests` error through its existing
60-second Queue retry path. Changed-payload conflicts remain permanent, as do other
non-retryable 4xx responses. Sender/recipient restrictions and the message protocol
are unchanged. The public consumer regression failed before the change (`ack`
instead of `retry`) and now passes for both 409 names.

## RPC quota and deployed capacity

[RPC](../../src/rpc.ts) verifies the service client, approved operation, subsystem,
target account, entitlement and binding. [ADR 0009](../adr/0009-private-rpc-service-identity.md)
explicitly permits an approved service to select eligible target users. The
[ST policy](../../src/services/st-mint-policy.ts) counts client records inside one
user's DO log; it does not promise a global client budget.

A local assertion using two disjoint logs for the same client allowed both at 29
records and denied a log at 30. Existing ST policy tests (17), external RPC tests
(23) and the same-user single-flight test passed. Per-user DO single-flight and
the [container's one-heavy-job slot](../../container/server.py) remain in place.

Read-only deployment/account APIs, D1 SELECTs and Workers Observability queries
completed the following checks on 2026-10-26:

| Check | Observation |
| --- | --- |
| Application capacity | `max_instances: 5`, `instances: 5`, `scheduling_policy: default`, APAC placement; each instance has 0.25 vCPU, 1,024 MiB memory and 4 GB disk. `instances` is configuration, not a running-instance measurement. |
| Account limits | Current `/containers/me` returned 1,500 vCPU, 6 TiB memory and 30 TB disk across concurrent deployments. The earlier 401 came from the legacy `/cloudchamber/me` endpoint. Account quota is not the application's five-instance limit. |
| Approved reach | One enabled calendar service client has the relevant RPC approvals; two non-banned users have `calendar.external`, active credentials and no inactive binding address. Only counts and approved methods were selected; no user credential or email was read. |
| Aggregate request observation | From 2026-10-25T13:00:00Z through 2026-10-26T13:00:00Z, 48 logged external RPC authorization attempts: 43 using the search privilege (also used by directory), 5 capture, one client and one user. Query `abr_level: 1`; all returned events fit the 2,000-event limit. Maximum observed rolling 60-second count across users: 1. Authorization attempts are not successful browser jobs. |
| Longer query | The seven-day query used `abr_level: 10`, so its 400-search/10-capture extrapolations are sampled estimates, not exact counts or peak evidence. |
| Metered usage | `containersUsageAdaptiveGroups`, filtered by this application's ID, returned CPU seconds, memory byte-seconds, disk byte-seconds and egress for October 1–26 (last day partial). Only one Container application exists in the account. |
| Billing | The authenticated Billable usage page showed resource line items for the current October 12–November 11 cycle, with observed usage through October 26. This is cycle-to-date billable usage, not a final invoice, and has a different period from the calendar-month GraphQL query. Financial details remain in local evidence. |

The Auth active version remained `e13f5f26-5a66-46b0-9e17-221240a38077` at the final
read; branch builds did not deploy this task's fixes. The observed traffic does not
demonstrate quota exhaustion. It also cannot rule out future abuse by an approved
client, or establish fairness under contention. The current contract intentionally
authorizes the service over eligible users and promises no account-wide client
budget; changing 30/minute into a global budget would change legitimate service
behavior. No arbitrary new quota or global coordination store was added.

Revisit client-wide admission control if the approved-client/eligible-user set or
cost/fairness requirements change. The retained controls are per-user/client
limits, same-user single-flight, per-container heavy-job exclusion and the deployed
instance ceiling; none should be described as a hard financial spending cap.

## Local validation

- Real HTTPS Chromium baseline and fixed checks described above; fixed normal
  top-level consent and same-origin empty binding creation both passed.
- Focused Node tests: 61 passed. Workers binding API tests: 10 passed.
- Full Node suite after the queue retry fix: 1004 passed across 111 files. The
  queue-focused suite passed 11 tests, and backend TypeScript passed. Full
  Workers/DO suite from the browser-isolation change: 462 passed across 49 files;
  Workers test TypeScript also passed. The later queue-only change does not touch
  a DO/HTTP/frontend path, so those checks were not repeated.
- OpenAPI generated twice; `check:api`, `lint:api` and `check:boundaries` passed.
- Frontend built with its pinned pnpm and telemetry disabled.

Review and CI results belong to the accompanying PR. The browser and queue
investigation harnesses and redacted deployment evidence are local
`.e2e/issue104/` artifacts; the maintained regressions remain at the existing
HTTP/ASSETS and queue-consumer boundaries. Production mail, enqueue, school traffic,
load generation, token revocation, merging and deployment were not performed.
