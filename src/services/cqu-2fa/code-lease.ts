import { LOGIN_LOCK_TTL_MS } from "./single-flight";
import type {
  BrowserRoute,
  LoginRouteRecord,
} from "../cqu-browser-routing";

// owner 在浏览器完成第一因素前就落盘，必须覆盖节点完整的 780s permit phase +
// permit claimed 后 660s 登录预算，再留 60s VPC/清理余量，共 1500s。
// 不能只按 post-permit 的 660s 预算设置，否则慢第一因素会与后继 owner 重叠。
export const CODE_LEASE_OWNER_TTL_MS = 1500 * 1000;
export const CODE_LEASE_QUEUE_TTL_MS = LOGIN_LOCK_TTL_MS;

export type LoginKind = "cas" | "atrust";

export interface CodeLeaseEntry {
  token: string;
  kind: LoginKind;
  queuedAt: number;
  /** 新格式:该 entry 对应的登录 token 有独立持久 browserRoute 记录。 */
  browserRouteVersion?: 1;
}

export interface CodeLease {
  ownerToken: string;
  ownerKind: LoginKind;
  acquiredAt: number;
  queue: CodeLeaseEntry[];
  /** 新格式 owner:FIFO 提升时从 entry 复制,锁删除后仍能区分新旧记录。 */
  ownerBrowserRouteVersion?: 1;
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
    ownerBrowserRouteVersion: next.browserRouteVersion,
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
      ownerBrowserRouteVersion: entry.browserRouteVersion,
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

export type ControlRouteResolution =
  | { outcome: "route"; route: BrowserRoute }
  | { outcome: "reject" };

/**
 * 验证码/permit 控制请求的后端解析(纯函数,设计 4.2 的顺序):
 *   ① 有持久 browserRoute 记录 → 固定用它的 route,不看当前全局开关;
 *   ② 无 route 但记录带 route version(新格式)→ 受控拒绝,绝不降级猜 node;
 *   ③ 无 route 且是不带 version 的旧格式锁/lease(部署前记录)→ 拒绝;
 *      (腾讯云节点已停用;旧记录不再外送,取受控失败)
 *   ④ 无任何记录的未知 token → 拒绝投递。
 */
export function resolveControlRoute(input: {
  routeRecord: LoginRouteRecord | null;
  routeVersioned: boolean;
}): ControlRouteResolution {
  const { routeRecord, routeVersioned } = input;
  if (routeRecord) {
    if (routeRecord.route.version !== 1) return { outcome: "reject" };
    return { outcome: "route", route: routeRecord.route };
  }
  if (routeVersioned) return { outcome: "reject" };
  return { outcome: "reject" };
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
