import { LOGIN_LOCK_TTL_MS } from "./single-flight";

// owner 在浏览器完成第一因素前就落盘，必须覆盖节点完整的 780s permit phase +
// permit claimed 后 660s 登录预算，再留 60s VPC/清理余量。与完整请求锁共用 1500s，
// 不能只按 post-permit 的 660s 预算设置，否则慢第一因素会与后继 owner 重叠。
export const CODE_LEASE_OWNER_TTL_MS = LOGIN_LOCK_TTL_MS;
export const CODE_LEASE_QUEUE_TTL_MS = LOGIN_LOCK_TTL_MS;

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
    (entry) => now - entry.queuedAt <= CODE_LEASE_QUEUE_TTL_MS
  );
  if (now - lease.acquiredAt <= CODE_LEASE_OWNER_TTL_MS) {
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
