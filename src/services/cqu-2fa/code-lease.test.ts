import { describe, expect, it } from "vitest";
import { LOGIN_LOCK_TTL_MS } from "./single-flight";
import {
  acquireCodeLease,
  pruneCodeLease,
  releaseCodeLease,
  type CodeLeaseEntry,
} from "./code-lease";

const cas = (token: string, queuedAt: number): CodeLeaseEntry => ({
  token,
  kind: "cas",
  queuedAt,
});

const atrust = (token: string, queuedAt: number): CodeLeaseEntry => ({
  token,
  kind: "atrust",
  queuedAt,
});

describe("verification-code lease", () => {
  it("makes the first login the owner", () => {
    expect(acquireCodeLease(null, cas("cas-1", 10), 10)).toEqual({
      ownerToken: "cas-1",
      ownerKind: "cas",
      acquiredAt: 10,
      queue: [],
    });
  });

  it("queues the other login kind without replacing the owner", () => {
    const first = acquireCodeLease(null, cas("cas-1", 10), 10);
    const second = acquireCodeLease(first, atrust("atrust-1", 20), 20);
    expect(second.ownerToken).toBe("cas-1");
    expect(second.queue).toEqual([atrust("atrust-1", 20)]);
  });

  it("does not duplicate an owner or queued token", () => {
    let lease = acquireCodeLease(null, cas("cas-1", 10), 10);
    lease = acquireCodeLease(lease, atrust("atrust-1", 20), 20);
    lease = acquireCodeLease(lease, cas("cas-1", 30), 30);
    lease = acquireCodeLease(lease, atrust("atrust-1", 30), 30);
    expect(lease.queue).toEqual([atrust("atrust-1", 20)]);
  });

  it("releasing the owner promotes the FIFO head with a fresh acquisition time", () => {
    let lease = acquireCodeLease(null, cas("cas-1", 10), 10);
    lease = acquireCodeLease(lease, atrust("atrust-1", 20), 20);
    lease = acquireCodeLease(lease, cas("cas-2", 30), 30);
    const promoted = releaseCodeLease(lease, "cas-1", 40);
    expect(promoted).toEqual({
      ownerToken: "atrust-1",
      ownerKind: "atrust",
      acquiredAt: 40,
      queue: [cas("cas-2", 30)],
    });
  });

  it("releasing a queued token removes only that entry", () => {
    let lease = acquireCodeLease(null, cas("cas-1", 10), 10);
    lease = acquireCodeLease(lease, atrust("atrust-1", 20), 20);
    expect(releaseCodeLease(lease, "atrust-1", 30)).toEqual({
      ...lease,
      queue: [],
    });
  });

  it("prunes a stale owner and stale queue entries before promotion", () => {
    const now = LOGIN_LOCK_TTL_MS + 100;
    let lease = acquireCodeLease(null, cas("cas-stale", 0), 0);
    lease = acquireCodeLease(lease, atrust("atrust-stale", 1), 1);
    lease = acquireCodeLease(
      lease,
      cas("cas-fresh", now - LOGIN_LOCK_TTL_MS),
      2
    );
    expect(pruneCodeLease(lease, now)).toEqual({
      ownerToken: "cas-fresh",
      ownerKind: "cas",
      acquiredAt: now,
      queue: [],
    });
  });

  it("returns null when the owner expires and no valid waiter remains", () => {
    const lease = acquireCodeLease(null, cas("cas-1", 0), 0);
    expect(pruneCodeLease(lease, LOGIN_LOCK_TTL_MS + 1)).toBeNull();
  });

  it("keeps an owner fenced across the node permit phase plus post-permit run budget", () => {
    const lease = acquireCodeLease(null, cas("cas-1", 0), 0);
    // The node may spend up to 780s reaching/claiming permit and then 660s
    // completing the owner run. The old 720s lease could overlap a successor.
    expect(pruneCodeLease(lease, 1_440_000)).toEqual(lease);
  });
});
