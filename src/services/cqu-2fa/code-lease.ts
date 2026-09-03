import { LOGIN_LOCK_TTL_MS } from "./single-flight";

export type LoginKind = "cas" | "atrust";

export interface CodeLeaseEntry {
  token: string;
  kind: LoginKind;
  queuedAt: number;
}

export interface CodeLease {
  ownerToken: string;
  ownerKind: LoginKind;
  acquiredAt: number;
  queue: CodeLeaseEntry[];
}

function promote(
  queue: CodeLeaseEntry[],
  now: number
): CodeLease | null {
  const [next, ...rest] = queue;
  if (!next) return null;
  return {
    ownerToken: next.token,
    ownerKind: next.kind,
    acquiredAt: now,
    queue: rest,
  };
}

export function pruneCodeLease(
  lease: CodeLease | null,
  now: number
): CodeLease | null {
  if (!lease) return null;
  const validQueue = lease.queue.filter(
    (entry) => now - entry.queuedAt <= LOGIN_LOCK_TTL_MS
  );
  if (now - lease.acquiredAt <= LOGIN_LOCK_TTL_MS) {
    return { ...lease, queue: validQueue };
  }
  return promote(validQueue, now);
}

export function acquireCodeLease(
  current: CodeLease | null,
  entry: CodeLeaseEntry,
  now: number
): CodeLease {
  const lease = pruneCodeLease(current, now);
  if (!lease) {
    return {
      ownerToken: entry.token,
      ownerKind: entry.kind,
      acquiredAt: now,
      queue: [],
    };
  }
  if (
    lease.ownerToken === entry.token ||
    lease.queue.some((queued) => queued.token === entry.token)
  ) {
    return lease;
  }
  return { ...lease, queue: [...lease.queue, entry] };
}

export function releaseCodeLease(
  current: CodeLease | null,
  token: string,
  now: number
): CodeLease | null {
  const lease = pruneCodeLease(current, now);
  if (!lease) return null;
  if (lease.ownerToken === token) {
    return promote(lease.queue, now);
  }
  return {
    ...lease,
    queue: lease.queue.filter((entry) => entry.token !== token),
  };
}
