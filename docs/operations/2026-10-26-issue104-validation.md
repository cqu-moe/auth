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
| Queue producer content trust | **still blocked** | The sole deployed Worker producer is Schedule; its reviewed source authorizes and renders messages. Effective Queue-write principals/ACL are not fully inventoried. No unauthorized producer was established. |
| Cross-user RPC client quota | **still blocked for aggregate cost/availability** | Independent per-user client buckets are confirmed and fit the service-identity design. Production has a five-instance ceiling; aggregate client usage, billing and account quota remain unverified. |

The first two results establish behavior under a controlled compromised-sibling
scenario, which is within [ADR 0002's isolation model](../adr/0002-first-party-session-isolation.md).
They do not establish an actual compromised production sibling or a production
account exploit. The remaining two candidates are not confirmed vulnerabilities;
keep #104 open for the outstanding deployment evidence.

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

`wrangler queues info schedule-notifications` reported one producer
(`worker:schedule-beta-cqu-moe`) and one consumer (`worker:cqu-moe-auth`). This is
the Worker-binding inventory, not an inventory of every credential permitted to
publish over the Cloudflare API.

The reviewed Schedule source was commit `5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284`:

- [Sync producer](https://github.com/cqu-moe/schedule/blob/5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284/src/cron/schedule-sync.ts#L1018) gates notifications on the owned subscription, persisted opt-in and `calendar.change_notification`; pending batches are persisted and replayed unchanged.
- [Email renderer](https://github.com/cqu-moe/schedule/blob/5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284/src/services/schedule-email.ts#L17) escapes dynamic HTML and builds the subject, body and links from fixed templates and schedule diffs.
- [ID generation](https://github.com/cqu-moe/schedule/blob/5f4a2d8c93189af553a6b8e0ef15dd5cdeff3284/src/services/schedule-notifications.ts#L377) hashes the user and old/new snapshot hashes; split messages receive distinct suffixes.

The [Auth consumer](../../src/queue/schedule-notifications.ts) rechecks the current
email, verification and entitlement, uses its fixed sender, and trusts admitted
producer content. A local assertion with injected `resolveRecipient/sendEmail`
confirmed that two different bodies with the same ID both reach the injected
sender. This proves the absence of local content binding; it is not a Resend send.

[Resend's documented contract](https://resend.com/docs/dashboard/emails/idempotency-keys)
rejects a reused key with a different payload with `409 invalid_idempotent_request`
within its 24-hour idempotency window. This was verified in official documentation,
not by sending email. No consumer rewrite is justified by the evidence obtained.

Remaining: inventory effective Queue-write principals/token policies, verify the
deployed Schedule revision against the reviewed source, and obtain controlled
provider evidence only if its documented behavior is insufficient for acceptance.

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

Read-only `wrangler containers info` reported the deployed
`cqu-moe-auth-cqulogincontainer` application with `max_instances: 5`,
`instances: 5`, `scheduling_policy: default`, and APAC placement. The `instances`
field is configuration data, not a measurement that five containers were running.
`wrangler deployments list` reported active Auth version
`e13f5f26-5a66-46b0-9e17-221240a38077`; this task did not deploy its changes.

The installed Wrangler's read-only `cloudchamber curl /me` returned HTTP 401, so
account-wide limits were not obtained. Per-client historical usage, eligible-user
counts and billing were not measured. The five-instance ceiling bounds deployment
scale, but cannot establish workload fairness, availability or actual cost. Do not
close this candidate as disproven, or introduce a new global quota, from these
facts alone.

## Local validation

- Real HTTPS Chromium baseline and fixed checks described above; fixed normal
  top-level consent and same-origin empty binding creation both passed.
- Focused Node tests: 61 passed. Workers binding API tests: 10 passed.
- Full Node suite: 1003 passed across 111 files. Full Workers/DO suite: 462 passed
  across 49 files. Both backend and Workers test TypeScript checks passed.
- OpenAPI generated twice; `check:api`, `lint:api` and `check:boundaries` passed.
- Frontend built with its pinned pnpm and telemetry disabled.

Review and CI results belong to the accompanying PR. The browser and queue
investigation harnesses are local `.e2e/issue104/` artifacts; the maintained
regressions remain at the existing HTTP/ASSETS boundaries.
