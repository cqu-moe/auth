# Randomized proactive CQU relogin research

## Decision

Use a two-piece uniform mixture for each successful account or QuickLogin login:

- 99%: uniform 6–7 hours.
- 1%: uniform 4–6 hours.

Draw one 32-bit value with `crypto.getRandomValues(new Uint32Array(1))`, map `r = value / 2**32`, and derive a continuous millisecond delay:

```ts
const hours = r < 0.01
  ? 4 + (r / 0.01) * 2
  : 6 + ((r - 0.01) / 0.99);
const delayMs = Math.floor(hours * 3_600_000);
```

Persist the resulting absolute time as optional `reloginAt = loginAt + delayMs`. Do not redraw on alarm retries, failures, or status reads. A successful login replaces the old `reloginAt`; a failed login keeps the existing retry/backoff path and does not consume a new success draw.

## Frequency

The expected delay is:

```text
0.99 × 6.5h + 0.01 × 5h = 6.485h
```

Relative to a fixed 7-hour cycle, expected proactive-login frequency increases by:

```text
(7 / 6.485) - 1 = 7.94%
```

That is about 3.7008 logins/day instead of 3.4286 logins/day per maintained session, or about 8.17 additional logins per 30 days per maintained session. Account and QuickLogin device sessions should draw independently.

## Random source

Use Workers Web Crypto, not `Math.random`. Cloudflare documents `crypto.getRandomValues()` as filling the supplied buffer with “cryptographically sound random values,” which is the appropriate source for a security-relevant timing distribution. A single `Uint32Array(1)` draw is sufficient for both the branch and the piecewise offset.

## Migration

No D1 migration is needed because these values live in Durable Object storage. When loading an account or maintaining a QuickLogin session without `reloginAt`:

1. Draw once and persist `reloginAt` transactionally with the existing session state.
2. Do not mutate `loginAt`.
3. On maintenance, schedule the earlier of `reloginAt` and any existing operational deadline.
4. If `reloginAt` is already past, schedule immediate relogin only when the session is otherwise eligible; preserve any earlier `reloginRetryAt`, in-flight login deadline, offline pause, or terminal-state guard.

The transactional check-before-write prevents duplicate draws or overwriting a concurrent state change. Do not wake paused, revoked, unbound, or otherwise inactive sessions just to migrate them.

Sleeping pre-upgrade sessions keep their existing alarm until their next maintenance wake. In particular, the previous no-probe experiment cohort may complete its first transition cycle at the old seven-hour target. Every newly successful login uses the full randomized distribution; the rollout does not bulk-trigger logins to retime old sessions.

## Alarm semantics

Cloudflare Durable Objects allow one alarm per object, and a new `setAlarm()` overrides the previous alarm. Alarms have at-least-once execution and automatic retries after uncaught failures. Therefore:

- Treat `reloginAt` as a target, not an exact deadline.
- If an alarm fires before `reloginAt`, reschedule to `reloginAt` and return.
- If it fires late, perform the relogin.
- Preserve earlier OTP, in-flight login, recovery, and retry deadlines when computing the single alarm.
- Keep alarm exception handling and explicit rescheduling; do not rely on the platform’s six automatic retries for indefinite recovery.

## Invariants

- Remove periodic CAS keepalive globally for account and QuickLogin sessions; keep on-demand ticket-mint failure recovery.
- Session usability remains `loginAt + 7h` from the latest successful login, independent of an earlier random renewal.
- Preserve OTP wait, code lease ownership, and in-flight login deadlines.
- Preserve existing retry/backoff and `reloginRetryAt`; randomization applies only to successful proactive renewal.
- Preserve QuickLogin’s seven-day inactivity pause before any automatic login.
- Settle already-completed keepalive accounting idempotently; do not issue a new probe just to settle old state.

## Sources

- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — `crypto.getRandomValues()` provides cryptographically sound random values.
- [Cloudflare Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) — one alarm per object, `setAlarm()` overrides, at-least-once execution, and bounded automatic retries.
- [2026-10-22 no-probe experiment](2026-10-22-no-probe-experiment.md) — prior no-probe account/device behavior and preserved OTP, retry, and pause boundaries.
- [CQU session DO](../../src/durable-objects/cqu-session.ts) — existing proactive relogin, alarm, OTP, and recovery paths.
- [QuickLogin maintenance](../../src/services/quicklogin/maintenance.ts) — existing device action, retry, and usability boundaries.
