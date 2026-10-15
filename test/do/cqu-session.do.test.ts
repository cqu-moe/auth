// CquSessionDO 集成测试(Workers pool, 真 workerd)。锁住 T4 在 cqu-session.ts 方法体里的
// 时序行为 —— 纯函数层(cqu-node-protocol.ts 等)已被 Node pool 覆盖, 但方法体 import
// `cloudflare:workers` 在 Node pool 起不来, 故这里在 workerd 内驱动 DO 方法 + spy 出站 LOGIN_NODE。
//
// 覆盖(按价值):
//   1. M7 防复活: keepalive 探活在途时 status 被改成 revoked → 写回前重查 status 命中撤销 → 不复活。
//   2. H4/L1: 取票路径节点 409 → DO 入口回 409(非 500)+ 排即时 alarm 快自愈 + 不同步重登。
//   3. transient: 节点 502 / fetch 抛 → status 不变, 不重登(走退避)。
//   4. H2: keepalive 回写超 120KiB 的 refreshed state → 不抛穿 alarm, 保留旧 state, 不重复铸票。
//
// 机制要点(spike 验证):
//   · LOGIN_NODE 是生产 wrangler.jsonc 的 vpc_services(remote:true)绑定, miniflare serviceBindings
//     覆盖它实测不生效(远程绑定优先 → "needs to be run remotely")。改为每用例在 workerd 内
//     vi.spyOn(env.LOGIN_NODE,"fetch") 拦截出站(DO 的 this.env.LOGIN_NODE 与测试 env.LOGIN_NODE
//     同隔离区同对象, spy 生效)。
//   · alarm() 经 runInDurableObject(stub, inst => inst.alarm()) 在 DO 上下文内直接驱动方法体。
//   · 测试框架强制每 DO I/O 隔离: 不能在持有某 DO 上下文时再 stub.fetch / runInDurableObject 另一
//     入口同 DO(会抛 "Cannot perform I/O on behalf of a different Durable Object")。故 M7 不靠
//     input-gate 真交错, 而是让 keepalive spy 往【同一 state.storage】写 revoked(同 DO 上下文)
//     来复现「探活在途 status 被改写」的因果, 断言写回分支命中撤销守卫。
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:test";
import { describe, it, expect, afterEach, vi, type MockInstance } from "vitest";
import { encrypt } from "../../src/services/crypto";
import {
  freshStub,
  validStorageState,
  validAtrustStorageState,
  seedSession,
  seedCredentials,
  driveAlarm,
  driveAlarmWith,
  readStatus,
  readAlarm,
  readState,
  readStorage,
  readStMintLog,
  captureSetAlarm,
  spyBrowserFetch,
} from "./helpers";

afterEach(async () => {
  // Retire prior objects and alarms before the next test installs browser spies.
  await reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * lease 组种子专用:为 codeLease/登录锁涉及的 token 补 CF 容器 route 记录与
 * version 标记(腾讯云节点停用后, fetchLoginControl 只认 cloudflare 持久 route)。
 */
async function seedLease(
  stub: DurableObjectStub,
  opts: {
    status?: string;
    storageState?: ReturnType<typeof validStorageState> | null;
    extra?: Record<string, unknown>;
  }
): Promise<void> {
  const extra = { ...(opts.extra ?? {}) };
  const lease = extra.codeLease as
    | { ownerToken?: string; ownerBrowserRouteVersion?: number; queue?: Array<{ token: string }> }
    | undefined;
  const tokens = new Set<string>();
  if (lease) {
    if (lease.ownerToken) tokens.add(lease.ownerToken);
    for (const entry of lease.queue ?? []) tokens.add(entry.token);
  }
  for (const key of ["loginInFlight", "atrustLoginInFlight"]) {
    const lock = extra[key] as { token?: string } | undefined;
    if (lock?.token) tokens.add(lock.token);
  }
  for (const token of tokens) {
    const kind: "cas" | "atrust" | "quicklogin" = token.startsWith("atrust")
      ? "atrust"
      : token.startsWith("quicklogin")
        ? "quicklogin"
        : "cas";
    Object.assign(extra, cfRouteRecord(token, kind));
  }
  if (lease) lease.ownerBrowserRouteVersion = 1;
  for (const key of ["loginInFlight", "atrustLoginInFlight"]) {
    const lock = extra[key] as { browserRouteVersion?: number } | undefined;
    if (lock) lock.browserRouteVersion = 1;
  }
  return seedSession(stub, { ...opts, extra });
}

async function runRetiredAtrustCleanup(stub: DurableObjectStub) {
  await runInDurableObject(stub, async (instance) => {
    const target = instance as unknown as {
      removeRetiredAtrustState: () => Promise<void>;
      recoverPendingCodePermit: () => Promise<void>;
    };
    await target.removeRetiredAtrustState();
    await target.recoverPendingCodePermit();
  });
}

async function restartDurableObject(stub: DurableObjectStub) {
  const id = stub.id;
  await abortAllDurableObjects();
  return env.CQU_SESSION.get(id);
}

async function recoverInterruptedLogins(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as unknown as { recoverInterruptedLogins: () => Promise<void> }
    ).recoverInterruptedLogins();
  });
}

async function finishLoginOperation(
  stub: DurableObjectStub,
  token: string,
  kind: "cas" | "atrust" | "quicklogin",
  completed = true
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as unknown as {
        finishLoginOperation: (
          token: string,
          lockKey: string,
          kind: "cas" | "atrust" | "quicklogin",
          completed: boolean
        ) => Promise<void>;
      }
    ).finishLoginOperation(
      token,
      kind === "cas" ? "loginInFlight" : `${kind}LoginInFlight`,
      kind,
      completed
    );
  });
}

describe("login activation recovery", () => {
  it("promotes a freshly persisted first-login state when only the final status write was interrupted", async () => {
    const stub = freshStub("cas-interrupted-success");
    const loginAt = Date.now() - 60_000;
    await seedSession(stub, {
      status: "unbound",
      loginAt,
      storageState: validStorageState(),
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get<Record<string, unknown>>("state");
      await state.storage.put({
        state: { ...stored, lastKeepAlive: loginAt },
        loginInFlight: {
          token: "interrupted-success",
          startedAt: loginAt - 30_000,
          browserRouteVersion: 1,
        },
        "browserRoute:interrupted-success": {
          token: "interrupted-success",
          kind: "cas",
          route: {
            version: 1,
            backend: "cloudflare",
            userId: "u1",
            bootId: "old-boot",
          },
          createdAt: loginAt - 30_000,
          expiresAt: Date.now() + 60_000,
        },
        codeLease: {
          ownerToken: "interrupted-success",
          ownerKind: "cas",
          acquiredAt: loginAt - 30_000,
          ownerCodeReceivedAt: loginAt - 10_000,
          queue: [],
        },
        codePermitProven: "interrupted-success",
      });
    });

    const restarted = await restartDurableObject(stub);
    const cancellations: string[] = [];
    spyBrowserFetch({
      "/login-cancel": async (request) => {
        cancellations.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false });
      },
    });
    const response = await restarted.fetch("http://do/status");

    expect(response.status).toBe(200);
    expect(await readStatus(restarted)).toBe("active");
    expect((await readState(restarted))?.storageState).toEqual(validStorageState());
    expect(cancellations).toEqual([]);
    expect(await readStorage(restarted, "loginInFlight")).toBeDefined();
    expect(await readStorage(restarted, "browserRoute:interrupted-success")).toBeDefined();

    await recoverInterruptedLogins(restarted);

    expect(cancellations).toEqual(["interrupted-success"]);
    expect(await readStorage(restarted, "loginInFlight")).toBeUndefined();
    expect(await readStorage(restarted, "codeLease")).toMatchObject({
      ownerToken: "interrupted-success",
      ownerCodeReceivedAt: loginAt - 10_000,
      recoveryFence: true,
    });
    expect(await readStorage(restarted, "interruptedLogins")).toEqual([
      expect.objectContaining({
        token: "interrupted-success",
        stopped: true,
        retryAt: loginAt - 10_000 + 10 * 60_000,
      }),
    ]);
    expect(await readAlarm(restarted)).not.toBeNull();
  });

  it.each(["revoked", "needs_reauth"] as const)(
    "does not resurrect an explicitly terminal %s session",
    async (status) => {
      const stub = freshStub(`cas-interrupted-success-${status}`);
      const loginAt = Date.now() - 60_000;
      await seedSession(stub, {
        status,
        loginAt,
        storageState: validStorageState(),
      });
      await runInDurableObject(stub, async (_instance, state) => {
        const stored = await state.storage.get<Record<string, unknown>>("state");
        await state.storage.put("state", { ...stored, lastKeepAlive: loginAt });
      });

      const restarted = await restartDurableObject(stub);
      expect((await restarted.fetch("http://do/status")).status).toBe(200);
      expect(await readStatus(restarted)).toBe(status);
    }
  );

  it("does not promote an old or subsequently refreshed state", async () => {
    const stub = freshStub("cas-interrupted-success-stale");
    const loginAt = Date.now() - 8 * 60 * 60_000;
    await seedSession(stub, {
      status: "unbound",
      loginAt,
      storageState: validStorageState(),
    });

    const restarted = await restartDurableObject(stub);
    expect((await restarted.fetch("http://do/status")).status).toBe(200);
    expect(await readStatus(restarted)).toBe("unbound");
  });

  it.each(["cas", "quicklogin"] as const)(
    "captures an interrupted %s login without browser I/O and releases it only after stopped proof",
    async (kind) => {
    const stub = freshStub(`${kind}-orphan-on-restart`);
    const now = Date.now();
    const lockKey = kind === "cas" ? "loginInFlight" : "quickloginLogin:device-a";
    const token = `${kind}-orphan`;
    await seedLease(stub, {
      status: kind === "cas" ? "binding" : "active",
      extra: {
        [lockKey]: { token, startedAt: now },
        codeLease: {
          ownerToken: token,
          ownerKind: kind,
          acquiredAt: now,
          queue: [],
        },
        codePermitPending: token,
      },
    });

    const restarted = await restartDurableObject(stub);
    const cancellations: string[] = [];
    const browserFetch = spyBrowserFetch({
      "/login-cancel": async (request) => {
        cancellations.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false });
      },
    });
    expect((await restarted.fetch("http://do/status")).status).toBe(200);
    expect(browserFetch).not.toHaveBeenCalled();
    expect(await readStorage(restarted, lockKey)).toMatchObject({ token });
    expect(await readStorage(restarted, "interruptedLogins")).toEqual([
      expect.objectContaining({ token, lockKey, kind }),
    ]);

    await recoverInterruptedLogins(restarted);

    expect(cancellations).toEqual([token]);
    expect(await readStorage(restarted, lockKey)).toBeUndefined();
    expect(await readStorage(restarted, `browserRoute:${token}`)).toBeUndefined();
    expect(await readStorage(restarted, "codeLease")).toBeUndefined();
    expect(await readStorage(restarted, "codePermitPending")).toBeUndefined();
    expect(await readStorage(restarted, "codePermitProven")).toBeUndefined();
    expect(await readStorage(restarted, "interruptedLogins")).toBeUndefined();
    expect(await readStatus(restarted)).toBe(kind === "cas" ? "expired" : "active");
  });

  it("restores an interrupted first binding without a prior session to unbound", async () => {
    const stub = freshStub("cas-orphan-first-binding");
    const now = Date.now();
    await seedLease(stub, {
      status: "binding",
      storageState: null,
      extra: {
        loginInFlight: { token: "cas-orphan", startedAt: now },
        codeLease: {
          ownerToken: "cas-orphan",
          ownerKind: "cas",
          acquiredAt: now,
          queue: [],
        },
      },
    });

    const restarted = await restartDurableObject(stub);
    spyBrowserFetch({
      "/login-cancel": () =>
        Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
    });
    await recoverInterruptedLogins(restarted);
    expect(await readStorage(restarted, "loginInFlight")).toBeUndefined();
    expect(await readStatus(restarted)).toBe("unbound");
  });

  it("converts a legacy observed-code proof into a timestamped recovery fence", async () => {
    const stub = freshStub("cas-orphan-partial-code-proof");
    const now = Date.now();
    await seedLease(stub, {
      status: "relogging",
      extra: {
        loginInFlight: { token: "cas-orphan", startedAt: now },
        codeLease: {
          ownerToken: "cas-orphan",
          ownerKind: "cas",
          acquiredAt: now,
          queue: [],
        },
        codePermitProven: "cas-orphan",
      },
    });

    const restarted = await restartDurableObject(stub);
    spyBrowserFetch({
      "/login-cancel": () =>
        Response.json({ ok: true, stopped: true, mayHaveRequestedCode: true }),
    });
    await recoverInterruptedLogins(restarted);
    const lease = await readStorage<{ ownerCodeReceivedAt: number; recoveryFence: boolean }>(
      restarted,
      "codeLease"
    );
    expect(await readStorage(restarted, "loginInFlight")).toBeUndefined();
    expect(lease).toMatchObject({ recoveryFence: true });
    expect(lease?.ownerCodeReceivedAt).toBeGreaterThanOrEqual(now);
    expect(await readStorage(restarted, "interruptedLogins")).toEqual([
      expect.objectContaining({
        token: "cas-orphan",
        stopped: true,
        retryAt: (lease?.ownerCodeReceivedAt ?? 0) + 10 * 60_000,
      }),
    ]);
  });

  it("keeps an observed OTP fenced to its original expiry and releases it afterward", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const stub = freshStub("cas-orphan-with-code");
    await seedLease(stub, {
      status: "relogging",
      extra: {
        loginInFlight: { token: "cas-orphan", startedAt: now },
        codeLease: {
          ownerToken: "cas-orphan",
          ownerKind: "cas",
          acquiredAt: now,
          ownerCodeReceivedAt: now,
          queue: [],
        },
        codePermitProven: "cas-orphan",
      },
    });

    const restarted = await restartDurableObject(stub);
    spyBrowserFetch({
      "/login-cancel": () =>
        Response.json({ ok: true, stopped: true, mayHaveRequestedCode: true }),
    });
    await recoverInterruptedLogins(restarted);
    expect(await readStorage(restarted, "loginInFlight")).toBeUndefined();
    expect(await readStorage(restarted, "codeLease")).toMatchObject({
      ownerToken: "cas-orphan",
      ownerCodeReceivedAt: now,
      recoveryFence: true,
    });

    vi.setSystemTime(now + 10 * 60_000 + 1);
    await recoverInterruptedLogins(restarted);
    expect(await readStorage(restarted, "codeLease")).toBeUndefined();
    expect(await readStorage(restarted, "interruptedLogins")).toBeUndefined();
    expect(await readStatus(restarted)).toBe("expired");
  });

  it("stops every activation-era lease owner and queued task without granting a lost permit", async () => {
    const stub = freshStub("all-lost-lease-participants");
    const now = Date.now();
    await seedLease(stub, {
      status: "relogging",
      extra: {
        loginInFlight: { token: "cas-orphan", startedAt: now },
        "quickloginLogin:device-a": {
          token: "quicklogin-owner",
          startedAt: now,
          deviceId: "device-a",
        },
        codeLease: {
          ownerToken: "quicklogin-owner",
          ownerKind: "quicklogin",
          acquiredAt: now,
          queue: [
            { token: "cas-orphan", kind: "cas", queuedAt: now },
            { token: "quicklogin-queued", kind: "quicklogin", queuedAt: now },
          ],
        },
        codePermitPending: "quicklogin-owner",
      },
    });

    const restarted = await restartDurableObject(stub);
    const cancellations: string[] = [];
    const permits: string[] = [];
    spyBrowserFetch({
      "/login-cancel": async (request) => {
        cancellations.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false });
      },
      "/code-permit": async (request) => {
        permits.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true });
      },
    });
    await recoverInterruptedLogins(restarted);

    expect(new Set(cancellations)).toEqual(
      new Set(["quicklogin-owner", "cas-orphan", "quicklogin-queued"])
    );
    expect(cancellations).toHaveLength(3);
    expect(permits).toEqual([]);
    expect(await readStorage(restarted, "loginInFlight")).toBeUndefined();
    expect(await readStorage(restarted, "quickloginLogin:device-a")).toBeUndefined();
    expect(await readStorage(restarted, "codeLease")).toBeUndefined();
    expect(await readStorage(restarted, "interruptedLogins")).toBeUndefined();
  });
});

describe("retired aTrust state cleanup", () => {
  it("deletes legacy aTrust state and preserves direct CAS state", async () => {
    const stub = freshStub("retired-atrust-state");
    const now = Date.now();
    await seedLease(stub, {
      status: "active",
      extra: {
        atrustGeneration: "legacy-generation",
        atrustSession: {
          status: "active",
          storageState: validAtrustStorageState(),
          loginAt: now,
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
        loginInFlight: { token: "cas-live", startedAt: now },
        atrustLoginInFlight: { token: "atrust-retired", startedAt: now },
        "browserRoute:atrust-unreferenced": {
          token: "atrust-unreferenced",
          kind: "atrust",
          route: { version: 1, backend: "cloudflare", userId: "u1" },
          createdAt: now,
          expiresAt: now + 60_000,
        },
        codeLease: {
          ownerToken: "atrust-retired",
          ownerKind: "atrust",
          acquiredAt: now,
          queue: [],
        },
        codePermitPending: "atrust-retired",
        codePermitProven: "atrust-retired",
        pendingCode: {
          code: "123456",
          kind: "login_2fa",
          ownerToken: "atrust-retired",
          ts: now,
          expiresAt: now + 60_000,
        },
      },
    });

    await runRetiredAtrustCleanup(stub);

    expect(await readStorage(stub, "atrustSession")).toBeUndefined();
    expect(await readStorage(stub, "atrustGeneration")).toBeUndefined();
    expect(await readStorage(stub, "atrustLoginInFlight")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:atrust-retired")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:atrust-unreferenced")).toBeUndefined();
    expect(await readStorage(stub, "codeLease")).toBeUndefined();
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
    expect(await readStorage(stub, "codePermitProven")).toBeUndefined();
    expect(await readStorage(stub, "pendingCode")).toBeUndefined();
    expect(await readStorage(stub, "loginInFlight")).toMatchObject({
      token: "cas-live",
    });
  });

  it("promotes a queued QuickLogin owner after deleting a retired aTrust owner", async () => {
    const stub = freshStub("retired-atrust-promote-quicklogin");
    const now = Date.now();
    await seedLease(stub, {
      status: "active",
      extra: {
        atrustLoginInFlight: { token: "atrust-retired", startedAt: now },
        codeLease: {
          ownerToken: "atrust-retired",
          ownerKind: "atrust",
          acquiredAt: now,
          queue: [
            {
              token: "quicklogin-next",
              kind: "quicklogin",
              queuedAt: now,
            },
          ],
        },
        codePermitPending: "atrust-retired",
      },
    });
    const permits: string[] = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        const body = (await request.json()) as { session: string };
        permits.push(body.session);
        return Response.json({ ok: true });
      },
    });

    await runRetiredAtrustCleanup(stub);

    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "quicklogin-next",
      ownerKind: "quicklogin",
      queue: [],
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
    expect(permits).toEqual(["quicklogin-next"]);
    expect(await readStorage(stub, "browserRoute:atrust-retired")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:quicklogin-next")).toBeDefined();
  });

  it("keeps a fresh retired owner fence until its observed code expires", async () => {
    const stub = freshStub("retired-atrust-live-code-fence");
    const now = Date.now();
    await seedLease(stub, {
      status: "active",
      extra: {
        atrustLoginInFlight: { token: "atrust-retired", startedAt: now },
        codeLease: {
          ownerToken: "atrust-retired",
          ownerKind: "atrust",
          ownerCodeReceivedAt: now,
          acquiredAt: now,
          queue: [
            {
              token: "quicklogin-next",
              kind: "quicklogin",
              queuedAt: now,
            },
          ],
        },
        codePermitPending: "atrust-retired",
        codePermitProven: "atrust-retired",
      },
    });

    await runRetiredAtrustCleanup(stub);

    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-retired",
      ownerKind: "atrust",
      ownerCodeReceivedAt: now,
      queue: [{ token: "quicklogin-next", kind: "quicklogin" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
    expect(await readStorage(stub, "codePermitProven")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:atrust-retired")).toBeUndefined();
    expect(await readAlarm(stub)).toBe(now + 10 * 60_000);
  });

  it("grants the successor once when the retired code fence expires after an intervening fetch", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const stub = freshStub("retired-atrust-expiry-promotion");
    await seedLease(stub, {
      status: "active",
      extra: {
        atrustLoginInFlight: { token: "atrust-retired", startedAt: now },
        codeLease: {
          ownerToken: "atrust-retired",
          ownerKind: "atrust",
          ownerCodeReceivedAt: now,
          acquiredAt: now,
          queue: [
            {
              token: "quicklogin-next",
              kind: "quicklogin",
              queuedAt: now,
            },
          ],
        },
        codePermitPending: "atrust-retired",
      },
    });
    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as {
        retiredAtrustCleanupComplete: boolean;
      };
      target.retiredAtrustCleanupComplete = false;
    });
    const permits: string[] = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        const body = (await request.json()) as { session: string };
        permits.push(body.session);
        return Response.json({ ok: true });
      },
      "/keepalive": async () =>
        Response.json({ ok: true, status: "unreachable" }),
    });

    expect((await stub.fetch("http://do/status")).status).toBe(200);
    expect(permits).toEqual([]);

    vi.setSystemTime(now + 10 * 60_000 + 1);
    await driveAlarm(stub);

    expect(permits).toEqual(["quicklogin-next"]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "quicklogin-next",
      ownerKind: "quicklogin",
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("removes queued aTrust entries without disturbing the active CAS owner", async () => {
    const stub = freshStub("retired-atrust-queued-behind-cas");
    const now = Date.now();
    await seedLease(stub, {
      status: "active",
      extra: {
        loginInFlight: { token: "cas-live", startedAt: now },
        atrustLoginInFlight: { token: "atrust-queued", startedAt: now },
        codeLease: {
          ownerToken: "cas-live",
          ownerKind: "cas",
          acquiredAt: now,
          queue: [
            { token: "atrust-queued", kind: "atrust", queuedAt: now },
            { token: "quicklogin-next", kind: "quicklogin", queuedAt: now },
          ],
        },
        codePermitPending: "cas-live",
      },
    });
    spyBrowserFetch({
      "/code-permit": async () => Response.json({ ok: true }),
    });

    await runRetiredAtrustCleanup(stub);

    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "cas-live",
      ownerKind: "cas",
      queue: [{ token: "quicklogin-next", kind: "quicklogin" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:cas-live")).toBeDefined();
    expect(await readStorage(stub, "browserRoute:atrust-queued")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:quicklogin-next")).toBeDefined();
  });
});

describe("verification-code lease orchestration", () => {
  it("deposit-code sends the code only to the lease owner token", async () => {
    const stub = freshStub("code-lease-owner");
    await seedLease(stub, {
      status: "active",
      extra: {
        loginInFlight: { token: "cas-1", startedAt: Date.now() },
        atrustLoginInFlight: { token: "atrust-1", startedAt: Date.now() },
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [],
        },
      },
    });

    const delivered: Array<{ session: string; code: string }> = [];
    spyBrowserFetch({
      "/code": async (request) => {
        delivered.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    const response = await stub.fetch("http://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "123456", kind: "login_2fa" }),
    });

    expect(response.status).toBe(200);
    expect(delivered).toEqual([{ session: "atrust-1", code: "123456" }]);
  });

  it("persists the owner's code receipt time before delivering the code", async () => {
    const stub = freshStub("code-lease-owner-code-time");
    const before = Date.now();
    await seedLease(stub, {
      status: "active",
      extra: {
        atrustLoginInFlight: { token: "atrust-1", startedAt: before },
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: before,
          queue: [],
        },
      },
    });
    let observedAtDelivery: number | undefined;

    await runInDurableObject(stub, async (instance, state) => {
      spyBrowserFetch({
        "/code": async () => {
          const lease = await state.storage.get<{ ownerCodeReceivedAt?: number }>(
            "codeLease"
          );
          observedAtDelivery = lease?.ownerCodeReceivedAt;
          return Response.json({ ok: true });
        },
      });
      await (
        instance as unknown as {
          depositCode: (payload: {
            code: string;
            kind: "login_2fa";
          }) => Promise<boolean>;
        }
      ).depositCode({ code: "123456", kind: "login_2fa" });
    });

    expect(observedAtDelivery).toBeGreaterThanOrEqual(before);
    expect(observedAtDelivery).toBeLessThanOrEqual(Date.now());
    expect(await readStorage(stub, "pendingCode")).toMatchObject({
      ownerToken: "atrust-1",
    });
  });

  it("releasing the owner promotes FIFO head and grants only it a fresh permit", async () => {
    const stub = freshStub("code-lease-promote");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "cas-1",
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [
            { token: "atrust-1", kind: "atrust", queuedAt: Date.now() },
          ],
        },
      },
    });

    const permits: Array<{ session: string }> = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        permits.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    await finishLoginOperation(stub, "cas-1", "cas");

    expect(permits).toEqual([{ session: "atrust-1" }]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      ownerKind: "atrust",
      queue: [],
    });
  });

  it("retries a transient permit failure before handing the promoted owner control", async () => {
    const stub = freshStub("code-lease-permit-retry");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "cas-1",
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [
            { token: "atrust-1", kind: "atrust", queuedAt: Date.now() },
          ],
        },
      },
    });

    let attempts = 0;
    spyBrowserFetch({
      "/code-permit": async () => {
        attempts += 1;
        return Response.json(
          { ok: attempts >= 3 },
          { status: attempts >= 3 ? 200 : 502 }
        );
      },
    });

    await finishLoginOperation(stub, "cas-1", "cas");

    expect(attempts).toBe(3);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("keeps a promoted owner fenced when every permit acknowledgement is lost", async () => {
    const stub = freshStub("code-lease-permit-terminal-failure");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "cas-1",
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [
            { token: "atrust-1", kind: "atrust", queuedAt: Date.now() },
          ],
        },
      },
    });
    spyBrowserFetch({
      "/code-permit": async () =>
        Response.json({ ok: false }, { status: 502 }),
    });

    await expect(finishLoginOperation(stub, "cas-1", "cas")).resolves.toBeUndefined();

    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      ownerKind: "atrust",
      queue: [],
    });
    expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
  });

  it("never promotes a successor when the node accepted a permit but every response was lost", async () => {
    const stub = freshStub("code-lease-permit-accepted-response-lost");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "cas-1",
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [
            { token: "atrust-1", kind: "atrust", queuedAt: Date.now() },
            { token: "cas-2", kind: "cas", queuedAt: Date.now() },
          ],
        },
      },
    });
    const accepted: string[] = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        const body = await request.json<{ session: string }>();
        accepted.push(body.session);
        throw new Error("response lost after accept");
      },
    });

    await expect(finishLoginOperation(stub, "cas-1", "cas")).resolves.toBeUndefined();

    expect(accepted).toEqual(["atrust-1", "atrust-1", "atrust-1"]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      queue: [{ token: "cas-2", kind: "cas" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
  });

  it("does not release an uncertain owner when permit acquisition never completed", async () => {
    const stub = freshStub("code-lease-pending-release");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [
            { token: "cas-2", kind: "cas", queuedAt: Date.now() },
          ],
        },
        codePermitPending: "atrust-1",
      },
    });
    const permit = spyBrowserFetch({
      "/login-cancel": async () => Response.json({ ok: false }, { status: 503 }),
      "/code-permit": async () => Response.json({ ok: true }),
    });

    await finishLoginOperation(stub, "atrust-1", "atrust", false);

    expect(permit).toHaveBeenCalledTimes(1);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      queue: [{ token: "cas-2", kind: "cas" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
  });

  it("replays a persisted permit marker after activation and commits only its acknowledgement", async () => {
    const stub = freshStub("code-lease-pending-recovery");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [],
        },
        codePermitPending: "atrust-1",
      },
    });
    const permits: Array<{ session: string }> = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        permits.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        recoverPendingCodePermit: () => Promise<void>;
      }).recoverPendingCodePermit();
    });

    expect(permits).toEqual([{ session: "atrust-1" }]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("same-owner acquire replays its durable permit marker without changing FIFO ownership", async () => {
    const stub = freshStub("code-lease-pending-acquire-replay");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [{ token: "cas-2", kind: "cas", queuedAt: Date.now() }],
        },
        codePermitPending: "atrust-1",
      },
    });
    const permits: string[] = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        permits.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true });
      },
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        acquireVerificationCodeLease: (
          token: string,
          kind: "atrust"
        ) => Promise<void>;
      }).acquireVerificationCodeLease("atrust-1", "atrust");
    });

    expect(permits).toEqual(["atrust-1"]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      queue: [{ token: "cas-2", kind: "cas" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("completed owner release promotes FIFO without replaying the finished owner's permit", async () => {
    const stub = freshStub("code-lease-pending-release-replay");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [{ token: "cas-2", kind: "cas", queuedAt: Date.now() }],
        },
        codePermitPending: "atrust-1",
      },
    });
    const permits: string[] = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        permits.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true });
      },
    });

    await finishLoginOperation(stub, "atrust-1", "atrust");

    expect(permits).toEqual(["cas-2"]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "cas-2",
      queue: [],
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("treats code proof published during a lost acknowledgement as confirmed permit evidence", async () => {
    const stub = freshStub("code-lease-marker-proof-during-grant");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [],
        },
        codePermitPending: "atrust-1",
      },
    });

    await runInDurableObject(stub, async (instance, state) => {
      spyBrowserFetch({
        "/code-permit": async () => {
          await state.storage.put("codePermitProven", "atrust-1");
          throw new Error("response lost after code arrived");
        },
      });
      await expect(
        (instance as unknown as {
          recoverPendingCodePermit: () => Promise<void>;
        }).recoverPendingCodePermit()
      ).resolves.toBeUndefined();
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
    expect(await readStorage(stub, "codePermitProven")).toBeUndefined();
  });

  it("treats a received login code as proof that the pending owner consumed its permit", async () => {
    const stub = freshStub("code-lease-pending-code-proof");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "atrust-1",
          ownerKind: "atrust",
          acquiredAt: Date.now(),
          queue: [],
        },
        codePermitPending: "atrust-1",
      },
    });
    const delivered: Array<{ session: string; code: string }> = [];
    spyBrowserFetch({
      "/code": async (request) => {
        delivered.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    const response = await stub.fetch("http://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "246810", kind: "login_2fa" }),
    });

    expect(response.status).toBe(200);
    expect(delivered).toEqual([{ session: "atrust-1", code: "246810" }]);
    expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
    expect(await readStorage(stub, "codePermitProven")).toBe("atrust-1");
  });

  it("promoting a stale owner grants the new permit but never forwards the stale arrival", async () => {
    const stub = freshStub("code-lease-stale-deposit");
    await seedLease(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "cas-stale",
          ownerKind: "cas",
          acquiredAt: 0,
          queue: [
            { token: "atrust-fresh", kind: "atrust", queuedAt: Date.now() },
          ],
        },
      },
    });

    const permits: Array<{ session: string }> = [];
    const delivered: Array<{ session: string; code: string }> = [];
    spyBrowserFetch({
      "/code-permit": async (request) => {
        permits.push(await request.json());
        return Response.json({ ok: true });
      },
      "/code": async (request) => {
        delivered.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    const response = await stub.fetch("http://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "654321", kind: "login_2fa" }),
    });

    expect(response.status).toBe(200);
    expect(permits).toEqual([{ session: "atrust-fresh" }]);
    expect(delivered).toEqual([]);
    expect(await readStorage(stub, "pendingCode")).toBeUndefined();
  });

  it("offers a still-valid pending code as reusable when FIFO promotes the next owner", async () => {
    const stub = freshStub("code-lease-reuse-pending");
    const now = Date.now();
    await seedLease(stub, {
      status: "active",
      extra: {
        pendingCode: {
          code: "123456",
          kind: "login_2fa",
          ts: now,
          expiresAt: now + 60_000,
        },
        codeLease: {
          ownerToken: "cas-1",
          ownerKind: "cas",
          acquiredAt: now,
          queue: [
            { token: "atrust-1", kind: "atrust", queuedAt: now },
          ],
        },
      },
    });

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let reusableAttempts = 0;
    spyBrowserFetch({
      "/code-permit": async (request) => {
        calls.push({ path: "/code-permit", body: await request.json() });
        return Response.json({ ok: true });
      },
      "/code": async (request) => {
        calls.push({ path: "/code", body: await request.json() });
        reusableAttempts += 1;
        return Response.json(
          { ok: reusableAttempts >= 3 },
          { status: reusableAttempts >= 3 ? 200 : 502 }
        );
      },
    });

    await finishLoginOperation(stub, "cas-1", "cas");

    expect(calls).toEqual([
      { path: "/code-permit", body: { session: "atrust-1" } },
      {
        path: "/code",
        body: { session: "atrust-1", code: "123456", reusable: true },
      },
      {
        path: "/code",
        body: { session: "atrust-1", code: "123456", reusable: true },
      },
      {
        path: "/code",
        body: { session: "atrust-1", code: "123456", reusable: true },
      },
    ]);
  });

  it.each(["revoke", "destroy"] as const)(
    "%s preserves an unexpired owner fence while invalidating login state",
    async (operation) => {
      const stub = freshStub(`code-lease-lifecycle-${operation}`);
      await seedLease(stub, {
        status: "active",
        extra: {
          codeLease: {
            ownerToken: "quicklogin-1",
            ownerKind: "quicklogin",
            acquiredAt: Date.now(),
            queue: [{ token: "cas-2", kind: "cas", queuedAt: Date.now() }],
          },
          codePermitPending: "quicklogin-1",
        },
      });

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          revoke: () => Promise<void>;
          destroy: () => Promise<void>;
        };
        if (operation === "revoke") await target.revoke();
        if (operation === "destroy") await target.destroy();
      });

      expect(await readStorage(stub, "codeLease")).toMatchObject({
        ownerToken: "quicklogin-1",
      });
      expect(await readStorage(stub, "codePermitPending")).toBe("quicklogin-1");
      if (operation === "destroy") {
        expect(await readStatus(stub)).toBe("unbound");
      }
      if (operation === "revoke") {
        expect(await readStatus(stub)).toBe("revoked");
      }
    }
  );

  it("commits revoke locally when the QuickLogin account notification is unavailable", async () => {
    const stub = freshStub("quicklogin-revoke-account-outage");
    await seedSession(stub, {
      status: "active",
      extra: {
        quickloginBindingEpoch: 3,
        "quickloginLogin:device-a": {
          token: "quicklogin-token",
          deviceId: "device-a",
          generation: 4,
          bindingEpoch: 3,
          startedAt: Date.now(),
          browserRouteVersion: 1,
        },
        "browserRoute:quicklogin-token": {
          token: "quicklogin-token",
          kind: "quicklogin",
          route: {
            version: 1,
            backend: "cloudflare",
            userId: "u1",
            containerKey: "quicklogin:u1:device-a",
            bootId: "quicklogin-boot",
          },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const notifyFetch = vi.fn().mockRejectedValue(new Error("account unavailable"));
    vi.spyOn(env.CQU_QUICKLOGIN_ACCOUNT, "get").mockReturnValue({
      fetch: notifyFetch,
    } as never);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await stub.fetch("https://do/revoke", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await readStatus(stub)).toBe("revoked");
    expect(await readStorage(stub, "quickloginLogin:device-a")).toBeUndefined();
    expect(await readStorage(stub, "interruptedLogins")).toEqual([
      expect.objectContaining({ token: "quicklogin-token", kind: "quicklogin" }),
    ]);
    expect(await readStorage(stub, "browserRoute:quicklogin-token")).toBeDefined();
    expect(notifyFetch).toHaveBeenCalledTimes(1);

    spyBrowserFetch({
      "/login-cancel": () =>
        Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
    });
    await recoverInterruptedLogins(stub);

    expect(await readStorage(stub, "interruptedLogins")).toBeUndefined();
    expect(await readStorage(stub, "browserRoute:quicklogin-token")).toBeUndefined();
  });

  it("bounds QuickLogin keepalive mint idempotency receipts", async () => {
    const stub = freshStub("quicklogin-mint-receipts");
    await seedSession(stub, { status: "active" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as {
        recordQuickloginKeepaliveMint(input: {
          deviceId: string;
          operationId: string;
          mintedAt: number;
        }): Promise<void>;
      };
      for (let index = 0; index < 70; index += 1) {
        await target.recordQuickloginKeepaliveMint({
          deviceId: "device-a",
          operationId: `operation-${index}`,
          mintedAt: Date.now(),
        });
      }
      const legacy = await state.storage.list({ prefix: "quickloginMint:" });
      const compact =
        (await state.storage.get<Array<{ operationId: string }>>(
          "quickloginMintReceipts"
        )) ?? [];
      expect(legacy.size + compact.length).toBeLessThanOrEqual(64);
      expect(compact).toContainEqual(
        expect.objectContaining({ operationId: "operation-69" })
      );
    });
  });
});

describe("persistent browser route records", () => {
  it("a second initiator against a live lock returns in_flight without new backend calls", async () => {
    const stub = freshStub("route-lock-race");
    const oldCredentials = await encrypt("old-password", env.ENCRYPTION_KEY);
    const newCredentials = await encrypt("new-password", env.ENCRYPTION_KEY);
    // 模拟发起者 A:活锁 + 成对 route 已落盘(在途)。workerd 的跨 DO I/O 隔离
    // 不允许把 mock 挂起后二次进入同一 DO,故用种子锁复现"同 kind 活锁在途"窗口。
    await seedSession(stub, {
      status: "relogging",
      extra: {
        credentials: {
          encryptedPassword: oldCredentials.ciphertext,
          iv: oldCredentials.iv,
        },
        quickloginBindingEpoch: 7,
        "quickloginLogin:device-a": {
          token: "quicklogin-device-a",
          deviceId: "device-a",
          generation: 3,
          bindingEpoch: 7,
          startedAt: Date.now(),
          browserRouteVersion: 1,
        },
        "browserRoute:quicklogin-device-a": {
          token: "quicklogin-device-a",
          kind: "quicklogin",
          route: {
            version: 1,
            backend: "cloudflare",
            userId: "u1",
            containerKey: "quicklogin:u1:device-a",
            bootId: "quicklogin-boot",
          },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
        loginInFlight: {
          token: "tok-a",
          startedAt: Date.now(),
          browserRouteVersion: 1,
        },
        "browserRoute:tok-a": {
          token: "tok-a",
          kind: "cas",
          route: { version: 1, backend: "cloudflare", userId: "u1", bootId: "boot-a" },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const fetchSpy = spyCfLogin({
      "/run": () => {
        throw new Error("second initiator must not start another /run");
      },
      "/code-permit": () => {
        throw new Error("second initiator must not send another permit");
      },
    });

    const response = await stub.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: "u1",
        studentId: "2026000002",
        encryptedPassword: newCredentials.ciphertext,
        iv: newCredentials.iv,
      }),
    });
    const result = (await response.json()) as { success: boolean; error?: string; code?: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe("CQU_LOGIN_IN_FLIGHT");
    expect(result.error).toContain("正在进行中");
    expect(fetchSpy).not.toHaveBeenCalled();
    const lockAfter = await readStorage(stub, "loginInFlight");
    expect(lockAfter).toMatchObject({ token: "tok-a", browserRouteVersion: 1 });
    expect(await readStorage(stub, "credentials")).toEqual({
      encryptedPassword: oldCredentials.ciphertext,
      iv: oldCredentials.iv,
    });
    expect(await readStorage(stub, "quickloginBindingEpoch")).toBe(7);
    expect(await readStorage(stub, "quickloginLogin:device-a")).toBeDefined();
    expect(await readStorage(stub, "browserRoute:quicklogin-device-a")).toBeDefined();
    expect(await readStatus(stub)).toBe("relogging");
    expect(await readStorage<{ studentId: string }>(stub, "state")).toMatchObject({
      studentId: "2020000001",
    });
    await runInDurableObject(stub, async (instance) => {
      const state = (instance as unknown as {
        state: { studentId: string } | null;
      }).state;
      expect(state).toBeNull();
    });
  });

  it("quicklogin rejects another device while a live same-account login pins the shared pool (#27)", async () => {
    const stub = freshStub("quicklogin-account-single-flight");
    await seedSession(stub, {
      status: "active",
      extra: {
        quickloginBindingEpoch: 7,
        "quickloginLogin:device-a": {
          token: "quicklogin-device-a",
          deviceId: "device-a",
          generation: 3,
          bindingEpoch: 7,
          startedAt: Date.now(),
          deadlineAt: Date.now() + 13 * 60_000,
          browserRouteVersion: 1,
        },
      },
    });
    await seedCredentials(stub);
    const fetchSpy = spyCfLogin({
      "/run": () => {
        throw new Error("second device must not start another /run");
      },
    });

    const result = await runInDurableObject(stub, async (instance) =>
      (instance as unknown as {
        quickloginLogin: (input: {
          ownerUserId: string;
          deviceId: string;
          generation: number;
        }) => Promise<{ kind: string; reasonCode?: string; retryAfterMs?: number }>;
      }).quickloginLogin({ ownerUserId: "u1", deviceId: "device-b", generation: 1 })
    );

    expect(result).toMatchObject({
      kind: "temporary_unavailable",
      reasonCode: "RATE_LIMITED",
    });
    expect(result?.retryAfterMs ?? 0).toBeGreaterThan(0);
    expect(result?.retryAfterMs ?? 0).toBeLessThanOrEqual(13 * 60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readStorage(stub, "quickloginLogin:device-a")).toBeDefined();
    expect(await readStorage(stub, "quickloginLogin:device-b")).toBeUndefined();
  });

  it("lock and route land atomically and exactly one permit is sent for the routed token", async () => {
    const stub = freshStub("route-atomic");
    const encrypted = await encrypt("test-password", env.ENCRYPTION_KEY);

    const runBodies: Array<{ session: string }> = [];
    const permitBodies: Array<{ session: string }> = [];
    let durableState: DurableObjectState | undefined;
    await runInDurableObject(stub, async (_instance, state) => {
      durableState = state;
    });
    let routeDuringRun: {
      token: string;
      kind: string;
      route: { version: number; backend: string; userId: string; bootId?: string };
    } | undefined;
    let lockDuringRun: { token: string; browserRouteVersion?: number } | undefined;
    spyCfLogin({
      "/run": async (request) => {
        const body = await request.json<{ session: string }>();
        runBodies.push(body);
        [lockDuringRun, routeDuringRun] = await Promise.all([
          durableState!.storage.get<{ token: string; browserRouteVersion?: number }>(
            "loginInFlight"
          ),
          durableState!.storage.get<{
            token: string;
            kind: string;
            route: {
              version: number;
              backend: string;
              userId: string;
              bootId?: string;
            };
          }>(`browserRoute:${body.session}`),
        ]);
        return Response.json({
          ok: false,
          error: "code wait timed out",
        });
      },
      "/code-permit": async (request) => {
        permitBodies.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    await stub.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: "u1",
        studentId: "2020000001",
        encryptedPassword: encrypted.ciphertext,
        iv: encrypted.iv,
      }),
    });

    expect(runBodies).toHaveLength(1);
    expect(permitBodies).toHaveLength(1);
    const [runBody] = runBodies;
    const [permitBody] = permitBodies;
    expect(permitBody.session).toBe(runBody.session);
    expect(lockDuringRun).toMatchObject({
      token: runBody.session,
      browserRouteVersion: 1,
    });
    expect(routeDuringRun?.token).toBe(runBody.session);
    expect(routeDuringRun?.kind).toBe("cas");
    expect(routeDuringRun?.route).toMatchObject({
      version: 1,
      backend: "cloudflare",
      bootId: "boot-1",
      userId: "u1",
    });

    const [lockAfterRun, routeAfterRun] = await runInDurableObject(stub, async (_inst, state) => {
      const lock = await state.storage.get<{
        token: string;
        browserRouteVersion?: number;
      }>("loginInFlight");
      const route = await state.storage.get<{
        token: string;
        kind: string;
        route: { version: number; backend: string; userId: string };
      }>(`browserRoute:${runBody.session}`);
      return [lock, route];
    });
    expect(lockAfterRun).toBeUndefined();
    expect(routeAfterRun).toBeUndefined();
  });

  it("credential repair validates in a clean context while preserving the prior committed state", async () => {
    const stub = freshStub("repair-seed-state");
    const previousState = validStorageState();
    await seedSession(stub, {
      status: "needs_reauth",
      storageState: previousState,
    });
    const encrypted = await encrypt("new-password", env.ENCRYPTION_KEY);
    const runBodies: Array<Record<string, unknown>> = [];
    spyCfLogin({
      "/run": async (request) => {
        runBodies.push(await request.json<Record<string, unknown>>());
        return Response.json({ ok: false, error: "test stop" });
      },
      "/code-permit": () => Response.json({ ok: true }),
    });

    await stub.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: "u1",
        studentId: "2020000001",
        encryptedPassword: encrypted.ciphertext,
        iv: encrypted.iv,
      }),
    });

    expect(runBodies).toHaveLength(1);
    expect(runBodies[0].seedState).toBeUndefined();
    expect((await readState(stub))?.storageState).toEqual(previousState);
  });

  it("repair login does not seed browser state across student ids", async () => {
    const stub = freshStub("repair-cross-account-seed");
    await seedSession(stub, { status: "needs_reauth" });
    const encrypted = await encrypt("new-password", env.ENCRYPTION_KEY);
    const runBodies: Array<Record<string, unknown>> = [];
    spyCfLogin({
      "/run": async (request) => {
        runBodies.push(await request.json<Record<string, unknown>>());
        return Response.json({ ok: false, error: "test stop" });
      },
      "/code-permit": () => Response.json({ ok: true }),
    });

    await stub.fetch("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: "u1",
        studentId: "2026000002",
        encryptedPassword: encrypted.ciphertext,
        iv: encrypted.iv,
      }),
    });

    expect(runBodies).toHaveLength(1);
    expect(runBodies[0]).not.toHaveProperty("seedState");
  });

  it("keeps expired routes referenced by a live lock, lease owner or outbox, drops the rest", async () => {
    const stub = freshStub("route-cleanup");
    const now = Date.now();
    await seedSession(stub, {
      status: "active",
      extra: {
        loginInFlight: {
          token: "tok-live-lock",
          startedAt: now,
          browserRouteVersion: 1,
        },
        codeLease: {
          ownerToken: "tok-lease-owner",
          ownerKind: "atrust",
          acquiredAt: now,
          queue: [
            { token: "tok-queued", kind: "cas", queuedAt: now, browserRouteVersion: 1 },
          ],
          ownerBrowserRouteVersion: 1,
        },
        codePermitPending: "tok-outbox",
        "browserRoute:tok-live-lock": {
          token: "tok-live-lock",
          kind: "cas",
          route: { version: 1, backend: "node", userId: "u1" },
          createdAt: 0,
          expiresAt: now - 1000,
        },
        "browserRoute:tok-lease-owner": {
          token: "tok-lease-owner",
          kind: "atrust",
          route: { version: 1, backend: "node", userId: "u1" },
          createdAt: 0,
          expiresAt: now - 1000,
        },
        "browserRoute:tok-queued": {
          token: "tok-queued",
          kind: "cas",
          route: { version: 1, backend: "node", userId: "u1" },
          createdAt: 0,
          expiresAt: now - 1000,
        },
        "browserRoute:tok-outbox": {
          token: "tok-outbox",
          kind: "cas",
          route: { version: 1, backend: "node", userId: "u1" },
          createdAt: 0,
          expiresAt: now - 1000,
        },
        "browserRoute:tok-dead": {
          token: "tok-dead",
          kind: "cas",
          route: { version: 1, backend: "node", userId: "u1" },
          createdAt: 0,
          expiresAt: now - 1000,
        },
        "browserRoute:tok-fresh": {
          token: "tok-fresh",
          kind: "cas",
          route: { version: 1, backend: "node", userId: "u1" },
          createdAt: now,
          expiresAt: now + 60_000,
        },
      },
    });

    await runInDurableObject(stub, async (inst) => {
      await (
        inst as unknown as {
          cleanupExpiredBrowserRoutes: () => Promise<void>;
        }
      ).cleanupExpiredBrowserRoutes();
    });

    const keys = await runInDurableObject(stub, async (_inst, state) => {
      const all = await state.storage.list({ prefix: "browserRoute:" });
      return [...all.keys()];
    });
    expect(new Set(keys)).toEqual(
      new Set([
        "browserRoute:tok-live-lock",
        "browserRoute:tok-lease-owner",
        "browserRoute:tok-queued",
        "browserRoute:tok-outbox",
        "browserRoute:tok-fresh",
      ])
    );
    expect(keys).not.toContain("browserRoute:tok-dead");
  });
});

describe("login control routing", () => {
  function seedCloudflareLogin(stub: DurableObjectStub, token: string, bootId = "boot-1") {
    return seedSession(stub, {
      status: "active",
      extra: {
        loginInFlight: { token, startedAt: Date.now(), browserRouteVersion: 1 },
        codeLease: {
          ownerToken: token,
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [],
          ownerBrowserRouteVersion: 1,
        },
        [`browserRoute:${token}`]: {
          token,
          kind: "cas",
          route: { version: 1, backend: "cloudflare", userId: "u1", bootId },
          createdAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        },
      },
    });
  }

  function spyContainerFetch(
    handler: (request: Request) => Response | Promise<Response>
  ): MockInstance {
    const fetchMock = vi.fn(handler);
    vi.spyOn(env.CQU_LOGIN, "get").mockReturnValue({
      fetch: fetchMock,
    } as never);
    vi.spyOn(env.CQU_LOGIN, "idFromName").mockReturnValue(
      "container-user-u1" as never
    );
    return fetchMock;
  }

  function captureControlRequest(
    respond: () => Response = () => Response.json({ ok: true })
  ) {
    const seen: Array<{
      path: string;
      bootId: string | null;
      body: unknown;
    }> = [];
    const fetchMock = spyContainerFetch(async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        bootId: request.headers.get("X-Cqu-Expected-Boot-Id"),
        body: request.method === "GET" ? null : await request.json(),
      });
      return respond();
    });
    return { seen, fetchMock };
  }

  it("delivers a fresh code to the persisted cloudflare route with the boot header", async () => {
    const stub = freshStub("control-cf-code");
    await seedCloudflareLogin(stub, "tok-cf");
    const nodeFetch = spyBrowserFetch({
      "/code": () => {
        throw new Error("cloudflare-routed code must not reach LOGIN_NODE");
      },
    });
    const { seen, fetchMock } = captureControlRequest();

    const response = await stub.fetch("https://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "123456", kind: "login_2fa" }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { delivered: boolean };
    expect(payload.delivered).toBe(true);
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({
      path: "/code",
      bootId: "boot-1",
      body: { session: "tok-cf", code: "123456" },
    });
  });

  it("keeps delivering to the cloudflare route even when the global default is node", async () => {
    // 测试 env 未配置 CQU_BROWSER_BACKEND(缺省 node);持久 route 为 cloudflare。
    // 这正是"CF 登录在途时开关切回 node,码仍送 CF"的等价可观测形式。
    const stub = freshStub("control-route-pin");
    await seedCloudflareLogin(stub, "tok-pin");
    spyBrowserFetch({
      "/code": () => {
        throw new Error("must stay on the persisted route");
      },
    });
    const { fetchMock } = captureControlRequest();
    await stub.fetch("https://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "654321", kind: "login_2fa" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a boot-replaced code without broadcasting to node or counting failures", async () => {
    const stub = freshStub("control-boot-replaced");
    await seedCloudflareLogin(stub, "tok-boot", "old-boot");
    const nodeFetch = spyBrowserFetch({
      "/code": () => {
        throw new Error("boot-replaced code must not fall back to node");
      },
    });
    const { fetchMock } = captureControlRequest(() =>
      Response.json({ ok: false, error: "BROWSER_INSTANCE_REPLACED" }, { status: 409 })
    );

    const response = await stub.fetch("https://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "111222", kind: "login_2fa" }),
    });
    const payload = (await response.json()) as { delivered: boolean };
    expect(payload.delivered).toBe(false);
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a versioned owner has no route record", async () => {
    const stub = freshStub("control-missing-route");
    await seedSession(stub, {
      status: "active",
      extra: {
        loginInFlight: {
          token: "tok-noroute",
          startedAt: Date.now(),
          browserRouteVersion: 1,
        },
        codeLease: {
          ownerToken: "tok-noroute",
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [],
          ownerBrowserRouteVersion: 1,
        },
      },
    });
    const nodeFetch = spyBrowserFetch({
      "/code": () => {
        throw new Error("missing route must not guess node");
      },
    });
    const { fetchMock } = captureControlRequest();
    const response = await stub.fetch("https://do/deposit-code", {
      method: "POST",
      body: JSON.stringify({ code: "999888", kind: "login_2fa" }),
    });
    const payload = (await response.json()) as { delivered: boolean };
    expect(payload.delivered).toBe(false);
    expect(nodeFetch).not.toHaveBeenCalled();
    // versioned owner 缺 route:两个后端都不投递(fetchLoginControl 受控失败)。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers a pending permit through the persisted cloudflare route after reactivation", async () => {
    const stub = freshStub("control-reactivation");
    await seedSession(stub, {
      status: "active",
      extra: {
        codeLease: {
          ownerToken: "tok-recover",
          ownerKind: "cas",
          acquiredAt: Date.now(),
          queue: [],
          ownerBrowserRouteVersion: 1,
        },
        codePermitPending: "tok-recover",
        [`browserRoute:tok-recover`]: {
          token: "tok-recover",
          kind: "cas",
          route: {
            version: 1,
            backend: "cloudflare",
            userId: "u1",
            bootId: "boot-react",
          },
          createdAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        },
      },
    });
    const nodeFetch = spyBrowserFetch({
      "/code-permit": () => {
        throw new Error("recovery must follow the persisted route");
      },
    });
    const { seen, fetchMock } = captureControlRequest();

    // 种子写入会先构造 DO(构造期 storage 尚空),故直接驱动恢复方法体 ——
    // 生产语义由"新进程首次加载即执行 recoverPendingCodePermit"保证。
    await runInDurableObject(stub, async (inst) => {
      await (
        inst as unknown as { recoverPendingCodePermit: () => Promise<void> }
      ).recoverPendingCodePermit();
    });
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({
      path: "/code-permit",
      bootId: "boot-react",
      body: { session: "tok-recover" },
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  describe("cloudflare route preparation", () => {
    async function drivePrepare(
      stub: DurableObjectStub,
      token: string,
      budgetMs = 1_000
    ): Promise<unknown> {
      return runInDurableObject(stub, async (inst) => {
        return (
          inst as unknown as {
            prepareLoginRoute: (
              token: string,
              route: unknown,
              lockKey: string,
              recheck: () => Promise<void>,
              budgetMs: number
            ) => Promise<unknown>;
          }
        ).prepareLoginRoute(
          token,
          { version: 1, backend: "cloudflare", userId: "u1" },
          "loginInFlight",
          async () => {},
          budgetMs
        );
      });
    }

    it("retries a cold start, validates capabilities, and writes bootId back to the route", async () => {
      const stub = freshStub("warmup-success");
      await seedSession(stub, {
        status: "active",
        extra: {
          loginInFlight: {
            token: "tok-warm",
            startedAt: Date.now(),
            browserRouteVersion: 1,
          },
          "browserRoute:tok-warm": {
            token: "tok-warm",
            kind: "cas",
            route: { version: 1, backend: "cloudflare", userId: "u1" },
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
          },
        },
      });
      let calls = 0;
      const { fetchMock } = captureControlRequest(() => {
        calls += 1;
        if (calls === 1) {
          return new Response("starting", { status: 503 });
        }
        return Response.json({
          ok: true,
          bootId: "boot-warm",
          browserProfile: "cloudflare",
          capabilities: [
            "code-permit",
            "browser-route-v1",
            "operation-deadline-v1",
          ],
        });
      });

      const route = (await drivePrepare(stub, "tok-warm")) as {
        bootId?: string;
      };
      expect(route.bootId).toBe("boot-warm");
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      const record = await readStorage<{
        route?: { backend?: string; bootId?: string; userId?: string };
      }>(stub, "browserRoute:tok-warm");
      expect(record).toMatchObject({
        token: "tok-warm",
        route: { backend: "cloudflare", bootId: "boot-warm", userId: "u1" },
      });
    });

    it("fails as BROWSER_BUSY when the container never reports a cloudflare profile", async () => {
      const stub = freshStub("warmup-timeout");
      await seedSession(stub, {
        status: "active",
        extra: {
          loginInFlight: {
            token: "tok-warm-timeout",
            startedAt: Date.now(),
            browserRouteVersion: 1,
          },
          "browserRoute:tok-warm-timeout": {
            token: "tok-warm-timeout",
            kind: "cas",
            route: { version: 1, backend: "cloudflare", userId: "u1" },
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
          },
        },
      });
      captureControlRequest(() =>
        Response.json({
          ok: true,
          bootId: "stale-boot",
          browserProfile: "default",
          capabilities: ["code-permit"],
        })
      );

      await expect(drivePrepare(stub, "tok-warm-timeout", 150)).rejects.toThrow(
        /preparation|busy|timed out/i
      );
      const record = await readStorage<{ route?: Record<string, unknown> }>(
        stub,
        "browserRoute:tok-warm-timeout"
      );
      expect(record?.route).not.toHaveProperty("bootId");
    });

    it("refuses the bootId writeback when the login token changed during warmup", async () => {
      const stub = freshStub("warmup-superseded");
      await seedSession(stub, {
        status: "active",
        extra: {
          loginInFlight: {
            token: "someone-else",
            startedAt: Date.now(),
            browserRouteVersion: 1,
          },
          "browserRoute:tok-old": {
            token: "tok-old",
            kind: "cas",
            route: { version: 1, backend: "cloudflare", userId: "u1" },
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
          },
        },
      });
      captureControlRequest(() =>
        Response.json({
          ok: true,
          bootId: "boot-late",
          browserProfile: "cloudflare",
          capabilities: ["browser-route-v1", "operation-deadline-v1"],
        })
      );

      await expect(drivePrepare(stub, "tok-old")).rejects.toThrow(
        /owner|replaced|changed/i
      );
      const record = await readStorage<{ route?: Record<string, unknown> }>(
        stub,
        "browserRoute:tok-old"
      );
      expect(record?.route).not.toHaveProperty("bootId");
    });
  });
});

describe("cloudflare CAS migration", () => {
  function withCloudflareBackend<T>(fn: () => Promise<T>): Promise<T> {
    const original = (env as { CQU_BROWSER_BACKEND?: string }).CQU_BROWSER_BACKEND;
    (env as { CQU_BROWSER_BACKEND?: string }).CQU_BROWSER_BACKEND = "cloudflare";
    return fn().finally(() => {
      delete (env as { CQU_BROWSER_BACKEND?: string }).CQU_BROWSER_BACKEND;
      if (original !== undefined) {
        (env as { CQU_BROWSER_BACKEND?: string }).CQU_BROWSER_BACKEND = original;
      }
    });
  }

  it("proactive 7h relogin sends /run to the user container with boot header and budget", async () => {
    const stub = freshStub("cf-relogin");
    await seedSession(stub, {
      status: "active",
      loginAt: Date.now() - 7 * 60 * 60 * 1000 - 1000,
    });
    await seedCredentials(stub);
    const seen: Array<{ path: string; bootId: string | null; body: any }> = [];
    const nodeFetch = spyBrowserFetch({
      "/run": () => {
        throw new Error("cloudflare relogin must not hit LOGIN_NODE");
      },
    });
    vi.spyOn(env.CQU_LOGIN, "get").mockReturnValue({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        seen.push({
          path: new URL(request.url).pathname,
          bootId: request.headers.get("X-Cqu-Expected-Boot-Id"),
          body: request.method === "GET" ? null : await request.json(),
        });
        if (request.method === "GET") {
          return Response.json({
            ok: true,
            bootId: "boot-relogin",
            browserProfile: "cloudflare",
            capabilities: ["browser-route-v1", "operation-deadline-v1"],
          });
        }
        return Response.json({ ok: false, error: "code wait timed out" });
      }),
    } as never);
    vi.spyOn(env.CQU_LOGIN, "idFromName").mockReturnValue("cf-id" as never);

    await withCloudflareBackend(() => driveAlarm(stub));

    expect(nodeFetch).not.toHaveBeenCalled();
    const run = seen.find((entry) => entry.path === "/run");
    expect(run).toBeDefined();
    expect(run?.bootId).toBe("boot-relogin");
    expect(run?.body.operationTimeoutMs).toBeGreaterThan(0);
    expect(run?.body.operationTimeoutMs).toBeLessThanOrEqual(780_000);
    expect(run?.body.session).toEqual(expect.any(String));
    expect(run?.body.seedState).toEqual({ cookies: [], origins: [] });
  });

  it("keepalive below the relogin threshold goes to the container with a bounded budget", async () => {
    const stub = freshStub("cf-keepalive");
    await seedSession(stub, {
      status: "active",
      loginAt: Date.now() - 60 * 60 * 1000,
    });
    const seen: Array<{ path: string; body: any }> = [];
    const nodeFetch = spyBrowserFetch({
      "/keepalive": () => {
        throw new Error("cloudflare keepalive must not hit LOGIN_NODE");
      },
    });
    vi.spyOn(env.CQU_LOGIN, "get").mockReturnValue({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(String(input));
        seen.push({
          path: new URL(request.url).pathname,
          body: request.method === "GET" ? null : await request.json(),
        });
        if (request.method === "GET") {
          return Response.json({ ok: true, apiVersion: "direct-harvest-v1" });
        }
        return Response.json({
          ok: true,
          status: "alive",
          state: validStorageState(),
        });
      }),
    } as never);
    vi.spyOn(env.CQU_LOGIN, "idFromName").mockReturnValue("cf-id" as never);

    await withCloudflareBackend(() => driveAlarm(stub));

    expect(nodeFetch).not.toHaveBeenCalled();
    const keepalive = seen.find((entry) => entry.path === "/keepalive");
    expect(keepalive).toBeDefined();
    expect(keepalive?.body.operationTimeoutMs).toBeGreaterThan(0);
    expect(keepalive?.body.operationTimeoutMs).toBeLessThanOrEqual(190_000);
    expect(await readStatus(stub)).toBe("active");
  });

  it("browser capacity exhaustion keeps the session and schedules a retry", async () => {
    const stub = freshStub("cf-keepalive-busy");
    await seedSession(stub, {
      status: "active",
      loginAt: Date.now() - 60 * 60 * 1000,
    });
    const nodeFetch = spyBrowserFetch({
      "/keepalive": () => {
        throw new Error("busy path must not fall back to node");
      },
    });
    vi.spyOn(env.CQU_LOGIN, "get").mockReturnValue({
      fetch: vi.fn(() =>
        Promise.resolve(new Response("capacity", { status: 503 }))
      ),
    } as never);
    vi.spyOn(env.CQU_LOGIN, "idFromName").mockReturnValue("cf-id" as never);

    await withCloudflareBackend(() => driveAlarm(stub));

    expect(nodeFetch).not.toHaveBeenCalled();
    expect(await readStatus(stub)).toBe("active");
    const state = await readState(stub);
    expect(state?.storageState).toBeDefined();
    const alarm = await readAlarm(stub);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now() - 1000);
  });

});

function pathsOf(spy: ReturnType<typeof spyBrowserFetch>): string[] {
  return spy.mock.calls.map((c) => {
    const input = c[0] as RequestInfo | URL;
    const url = input instanceof Request ? input.url : String(input);
    return new URL(url).pathname;
  });
}

/** 组装 CF 登录 route 记录(容器后端,带 bootId;userId 固定为种子 u1)。 */
function cfRouteRecord(
  token: string,
  kind: "cas" | "atrust" | "quicklogin" = "cas",
  bootId = "boot-1"
): Record<string, unknown> {
  return {
    [`browserRoute:${token}`]: {
      token,
      kind,
      route: {
        version: 1,
        backend: "cloudflare",
        userId: "u1",
        ...(kind === "quicklogin"
          ? { containerKey: `quicklogin:u1:${token}` }
          : {}),
        bootId,
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    },
  };
}

/** CF 容器登录桩:GET /health 返回可预热 bootId,其余按 path 路由。 */
function spyCfLogin(
  handlers: Record<string, (req: Request) => Response | Promise<Response>>
): MockInstance {
  const withHealth: Record<string, (req: Request) => Response | Promise<Response>> = {
    ...handlers,
  };
  if (!withHealth["/health"]) {
    withHealth["/health"] = async () =>
      Response.json({
        ok: true,
        bootId: "boot-1",
        browserProfile: "cloudflare",
        capabilities: [
          "code-permit",
          "browser-route-v1",
          "operation-deadline-v1",
        ],
      });
  }
  if (!withHealth["/login-cancel"]) {
    withHealth["/login-cancel"] = async () =>
      Response.json({
        ok: true,
        stopped: true,
        mayHaveRequestedCode: false,
      });
  }
  return spyBrowserFetch(withHealth);
}

// ── 1. M7 防复活 ────────────────────────────────────────────────────────────
describe("M7 anti-resurrection", () => {
  it("status flipped to revoked while keepalive probe in flight → not resurrected (no active writeback / no alarm)", async () => {
    const stub = freshStub("m7-revoke");
    await seedSession(stub, { status: "active" });

    await driveAlarmWith(stub, async (_inst, state) => {
      // keepalive 探活返回 alive, 但出站在途期间把 status 改成 revoked(同 DO 上下文写盘,
      // 模拟 admin revoke 在 alarm await LOGIN_NODE.fetch 期间落盘)。
      spyBrowserFetch({
        "/keepalive": async () => {
          await state.storage.put("status", "revoked");
          await state.storage.deleteAlarm();
          return Response.json({ ok: true, status: "alive" }, { status: 200 });
        },
      });
    });

    // alarm 的 active 写回分支重查 status 命中 revoked → 放弃: 不 setStatus("active")、不 setAlarm。
    expect(await readStatus(stub)).toBe("revoked");
    expect(await readAlarm(stub)).toBeNull();
  });

  it("status flipped to needs_reauth while probe in flight → not re-armed (halt terminal state)", async () => {
    const stub = freshStub("m7-halt");
    await seedSession(stub, { status: "active" });

    await driveAlarmWith(stub, async (_inst, state) => {
      spyBrowserFetch({
        "/keepalive": async () => {
          await state.storage.put("status", "needs_reauth");
          await state.storage.deleteAlarm();
          return Response.json({ ok: true, status: "alive" }, { status: 200 });
        },
      });
    });

    // needs_reauth 是熔断终态, 同样命中 shouldAbandonKeepaliveWriteback → 不复活、不重排。
    expect(await readStatus(stub)).toBe("needs_reauth");
    expect(await readAlarm(stub)).toBeNull();
  });

  it("control: keepalive alive on healthy active session → stays active, re-arms alarm, records 1 keepalive ST mint", async () => {
    // 对照组: 无撤销交错时 keepalive alive 正常写回 active + 重排 alarm —— 证明上面 revoked 不复活
    // 不是因为路径压根没跑到写回(否则这条同样会停在 active 不变, 无法区分)。
    const stub = freshStub("m7-control");
    await seedSession(stub, { status: "active" });

    const spy = spyBrowserFetch({
      "/keepalive": async () =>
        Response.json({ ok: true, status: "alive" }, { status: 200 }),
    });

    await driveAlarm(stub);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await readStatus(stub)).toBe("active");
    expect(await readAlarm(stub)).not.toBeNull();
    // keepalive alive 真铸了一张 ST → 记一条限流账(哨兵 clientId, source keepalive, broad=false)。
    const log = await readStMintLog(stub);
    expect(log).toHaveLength(1);
    expect(log[0].clientId).toBe("__keepalive__");
    expect(log[0].broad).toBe(false);
  });
});

// ── 2. H4 / L1: 取票节点 409 → 409 + 排即时 alarm + 不同步重登 ───────────────
describe("H4/L1 service-ticket node 409", () => {
  it("node /service-ticket 409 → DO entry returns 409 (not 500), arms immediate alarm, does NOT relogin synchronously", async () => {
    const stub = freshStub("h4-409");
    await seedSession(stub, { status: "active" });

    // 先挂 setAlarm spy(确定性断言「排了即时 alarm」, 避开即时 alarm 自动触发的 getAlarm 竞态)。
    const setAlarmCalls = await captureSetAlarm(stub);

    const spy = spyBrowserFetch({
      "/service-ticket": async () =>
        Response.json({ ok: false, error: "cas-login" }, { status: 409 }),
      // 即时 alarm 触发后会跑一轮 keepalive; 桩成 alive 让它确定性收敛(不污染断言)。
      "/keepalive": async () =>
        Response.json({ ok: true, status: "alive" }, { status: 200 }),
    });

    const res = await stub.fetch(
      "http://do/service-ticket?service=jwxt&source=route",
      { method: "POST" }
    );

    // L1: 409(TGT_EXPIRED)原样回, 不伪装成 500。
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TGT_EXPIRED");

    // H4: 取票热路径排了一个即时 alarm(快自愈, 交后台异步重登)。
    expect(setAlarmCalls.length).toBeGreaterThanOrEqual(1);
    expect(setAlarmCalls[0] - Date.now()).toBeLessThanOrEqual(1000);

    // 绝不在取票热路径同步重登: 出站只打了 /service-ticket(其后的 /keepalive 是即时 alarm 引发的,
    // 不是取票链同步调的; /run 一次都没有)。
    expect(pathsOf(spy)).not.toContain("/run");
  });
});

// ── 3. transient: 节点 502 / fetch 抛 → status 不变, 不重登 ──────────────────
describe("transient failures", () => {
  it("service-ticket node 502 → WAF_CHALLENGE (503), status unchanged, no immediate alarm, no relogin", async () => {
    const stub = freshStub("transient-502");
    await seedSession(stub, { status: "active" });
    const setAlarmCalls = await captureSetAlarm(stub);

    const spy = spyBrowserFetch({
      "/service-ticket": async () => Response.json({ ok: false }, { status: 502 }),
    });

    const res = await stub.fetch(
      "http://do/service-ticket?service=jwxt&source=route",
      { method: "POST" }
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WAF_CHALLENGE");

    expect(pathsOf(spy)).toEqual(["/service-ticket"]); // 仅取票一跳, 无 /run 同步重登
    expect(await readStatus(stub)).toBe("active"); // status 不变
    // transient 不排即时 alarm(只有 409/TGT_EXPIRED 才 setAlarm 快自愈)。
    expect(setAlarmCalls).toHaveLength(0);
  });

  it("service-ticket node fetch throws (abort/timeout) → WAF_CHALLENGE, status unchanged, no immediate alarm", async () => {
    const stub = freshStub("transient-throw");
    await seedSession(stub, { status: "active" });
    const setAlarmCalls = await captureSetAlarm(stub);

    const spy = spyBrowserFetch({
      "/service-ticket": async () => {
        // 模拟 AbortSignal.timeout 触发 / VPC 网络层异常。
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });

    const res = await stub.fetch(
      "http://do/service-ticket?service=jwxt&source=route",
      { method: "POST" }
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WAF_CHALLENGE");
    expect(pathsOf(spy)).toEqual(["/service-ticket"]);
    expect(await readStatus(stub)).toBe("active");
    expect(setAlarmCalls).toHaveLength(0);
  });

  it("keepalive probe unreachable (node 502) → session kept, status active, backed-off alarm (not immediate), no relogin, no ST mint", async () => {
    const stub = freshStub("transient-keepalive");
    await seedSession(stub, { status: "active" });

    const spy = spyBrowserFetch({
      "/keepalive": async () => Response.json({ ok: false }, { status: 502 }),
    });

    await driveAlarm(stub);

    // transient keepalive: 保会话 + status 不动 + 退避重排(delay>0, 非即时) + 绝不重登。
    expect(await readStatus(stub)).toBe("active");
    expect(pathsOf(spy)).toEqual(["/keepalive"]); // 无 /run
    const alarm = await readAlarm(stub);
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeGreaterThan(1000);
    // transient 探活不铸票 → 无 ST 限流账。
    expect(await readStMintLog(stub)).toHaveLength(0);
  });
});

// ── 4. H2: keepalive 回写超 120KiB refreshed state → 不抛穿, 保旧 state ───────
describe("H2 oversized refreshed state on keepalive", () => {
  it("keepalive returns >120KiB refreshed state → alarm does not throw, old state kept, stays active, mints once", async () => {
    const stub = freshStub("h2-oversize");
    await seedSession(stub, { status: "active", storageState: validStorageState() });

    // hasValidTgt=true 但序列化 >120KiB(灌一个大 localStorage)的 refreshed state。
    const huge = "x".repeat(130 * 1024);
    const oversized = {
      cookies: validStorageState().cookies,
      origins: [
        {
          origin: "https://my.cqu.edu.cn",
          localStorage: [{ name: "bloat", value: huge }],
        },
      ],
    };

    const spy = spyBrowserFetch({
      "/keepalive": async () =>
        Response.json(
          { ok: true, status: "alive", state: oversized },
          { status: 200 }
        ),
    });

    // 不抛穿(alarm 抛 → CF 自动重试 → 重复铸票环 + state 永远写不进)。
    await expect(driveAlarm(stub)).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await readStatus(stub)).toBe("active");

    // 旧 state 保留(超限刷新态被丢弃, 不顶替)。
    const persisted = await readState(stub);
    const ls = persisted?.storageState?.origins?.[0]?.localStorage ?? [];
    expect(ls.find((e) => e.name === "bloat")).toBeUndefined();
    expect(
      persisted?.storageState?.cookies.find((c) => c.name === "SOURCEID_TGC")?.value
    ).toBe("tgt-value");

    // keepalive alive 仍只铸一张票(记一条账), 不因超限重复铸。
    expect(await readStMintLog(stub)).toHaveLength(1);
  });

  it("keepalive returns refreshed state lacking CAS cookies → keeps old state (no half-baked overwrite)", async () => {
    const stub = freshStub("h2-halfbaked");
    await seedSession(stub, { status: "active" });

    spyBrowserFetch({
      "/keepalive": async () =>
        Response.json(
          { ok: true, status: "alive", state: { cookies: [], origins: [] } },
          { status: 200 }
        ),
    });

    await driveAlarm(stub);

    expect(await readStatus(stub)).toBe("active");
    const persisted = await readState(stub);
    // 空 refreshed state(无 TGT)未顶替, 旧三件套仍在。
    expect(
      persisted?.storageState?.cookies.find((c) => c.name === "SOURCEID_TGC")?.value
    ).toBe("tgt-value");
  });
});

// ── 5. data-harvest action: 四闸复用 + 节点出站映射 ──────────────────────────
describe("data-harvest action", () => {
  const recipe = {
    navUrl: "https://my.cqu.edu.cn/workspace/curriculum",
    capture: ["student/my-table-detail"],
    fetch: [{ method: "GET", url: "https://my.cqu.edu.cn/api/exam/x" }],
  };

  async function postHarvest(stub: DurableObjectStub) {
    return stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify(recipe),
    });
  }

  it("active session + node 200 → returns captures/fetches, records 1 ST mint, audits", async () => {
    const stub = freshStub("harvest-ok");
    await seedSession(stub, { status: "active" });

    spyBrowserFetch({
      "/data-harvest": async () =>
        Response.json(
          {
            ok: true,
            captures: [{ url: "u", status: 200, contentType: "application/json", body: "{}" }],
            fetches: [{ url: "https://my.cqu.edu.cn/api/exam/x", status: 200, body: "[]" }],
          },
          { status: 200 }
        ),
    });

    const res = await postHarvest(stub);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { captures: unknown[]; fetches: unknown[] };
    expect(body.captures).toHaveLength(1);
    expect(body.fetches).toHaveLength(1);
    // 真出数动作 → 记一条限流账(harvest source, broad=false)。
    const log = await readStMintLog(stub);
    expect(log).toHaveLength(1);
    expect(log[0].clientId).toBe("calendar");
  });

  it("status not active (needs_reauth) → NEEDS_REAUTH error, no node call", async () => {
    const stub = freshStub("harvest-reauth");
    await seedSession(stub, { status: "needs_reauth" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await postHarvest(stub);
    expect(res.status).toBe(409); // cquErrorHttpStatus(NEEDS_REAUTH)
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("NEEDS_REAUTH");
    expect(spy).not.toHaveBeenCalled();
  });

  it("disallowed navUrl host → INVALID_HARVEST_URL, no node call", async () => {
    const stub = freshStub("harvest-badhost");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({ ...recipe, navUrl: "https://lib.cqu.edu.cn/x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_HARVEST_URL");
    expect(spy).not.toHaveBeenCalled();
  });

  it("non-GET fetch method → INVALID_HARVEST_URL (400) before rate-limit accounting, no node call, no ST mint", async () => {
    const stub = freshStub("harvest-nonget");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({
        ...recipe,
        fetch: [{ method: "POST", url: "https://my.cqu.edu.cn/api/exam/x" }],
      }),
    });

    // 非 GET 是客户端契约错 → 400(在限流记账之前抛, 不消耗限流槽)。
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_HARVEST_URL");
    // 没出站节点; 没记一条限流账(校验早于记账)。
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("capture not an array → INVALID_HARVEST_URL (400) before accounting, no node call, no ST mint", async () => {
    const stub = freshStub("harvest-capture-notarray");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({ ...recipe, capture: "not-a-list" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("INVALID_HARVEST_URL");
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("capture with a non-string entry → INVALID_HARVEST_URL (400), no node call, no ST mint", async () => {
    const stub = freshStub("harvest-capture-nonstring");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({ ...recipe, capture: ["ok/pat", 123] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("INVALID_HARVEST_URL");
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("fetch entry missing url → INVALID_HARVEST_URL (400) before accounting, no node call, no ST mint", async () => {
    const stub = freshStub("harvest-fetch-nourl");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({ ...recipe, fetch: [{ method: "GET" }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("INVALID_HARVEST_URL");
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("non-canonical-but-valid navUrl/fetch url → succeeds with CANONICAL urls forwarded to node (no WAF_CHALLENGE)", async () => {
    // Finding 1: Workers URL parser canonicalizes (e.g. percent-encoded host / scheme-relative)
    // 但 Python urlparse 不会 —— 若 DO 转发原文, 节点 parse_harvest_recipe 再拒成 400 → WAF_CHALLENGE。
    // 此处断言 DO 把 validateCquHarvestUrl 的 canonical 返回值转给节点(节点收到的是规范化 url)。
    const stub = freshStub("harvest-canonical");
    await seedSession(stub, { status: "active" });

    let received: { navUrl?: string; fetch?: { url?: string }[] } | null = null;
    const spy = spyBrowserFetch({
      "/data-harvest": async (req) => {
        received = (await req.json()) as { navUrl?: string; fetch?: { url?: string }[] };
        return Response.json(
          { ok: true, captures: [], fetches: [] },
          { status: 200 }
        );
      },
    });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({
        // 百分号编码 host(%6d%79 = "my") + scheme-relative fetch url —— 两者 Workers 规范化, Python 拒。
        navUrl: "https://%6d%79.cqu.edu.cn/workspace/curriculum",
        capture: ["student/my-table-detail"],
        fetch: [{ method: "GET", url: "https:my.cqu.edu.cn/api/exam/x" }],
      }),
    });

    // 规范化后 host 合法 → 200 成功(不是 WAF_CHALLENGE/500)。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code?: string }).code).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);

    // 节点收到的是 CANONICAL url(Python urlparse 能直接放行), 而非客户端原文。
    expect(received).not.toBeNull();
    expect(received!.navUrl).toBe("https://my.cqu.edu.cn/workspace/curriculum");
    expect(received!.fetch?.[0]?.url).toBe("https://my.cqu.edu.cn/api/exam/x");
    // 校验通过 → 记一条限流账。
    expect(await readStMintLog(stub)).toHaveLength(1);
  });

  it("non-string fetch method (number) → INVALID_HARVEST_URL (400) before accounting, no node call, no ST mint", async () => {
    // Finding 2: (f.method ?? "GET").toUpperCase() 对非字符串 method 抛 TypeError → 500 INTERNAL_ERROR。
    // 应是文档化的 400 客户端契约错(GET-only), 且在记账之前抛。
    const stub = freshStub("harvest-method-nonstring");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({
        ...recipe,
        fetch: [{ method: 42, url: "https://my.cqu.edu.cn/api/exam/x" }],
      }),
    });

    // 非字符串 method 是客户端契约错 → 400(非 500 TypeError), 在记账之前。
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("INVALID_HARVEST_URL");
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("node 409 → TGT_EXPIRED (409), arms immediate alarm, no sync relogin", async () => {
    const stub = freshStub("harvest-409");
    await seedSession(stub, { status: "active" });
    const setAlarmCalls = await captureSetAlarm(stub);
    const spy = spyBrowserFetch({
      "/data-harvest": async () => Response.json({ ok: false }, { status: 409 }),
      "/keepalive": async () => Response.json({ ok: true, status: "alive" }, { status: 200 }),
    });

    const res = await postHarvest(stub);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("TGT_EXPIRED");
    expect(setAlarmCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      spy.mock.calls.map((c) => new URL((c[0] as Request).url).pathname)
    ).not.toContain("/run");
  });

  it("node 502 without a stable code → HARVEST_TRANSIENT (503), status unchanged", async () => {
    const stub = freshStub("harvest-502");
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({
      "/data-harvest": async () => Response.json({ ok: false }, { status: 502 }),
    });
    const res = await postHarvest(stub);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe("HARVEST_TRANSIENT");
    expect(await readStatus(stub)).toBe("active");
  });

  it.each([
    ["WAF_BOOTSTRAP_TIMEOUT", 503], ["APP_READY_TIMEOUT", 503],
    ["TABLE_CAPTURE_TIMEOUT", 503], ["TABLE_REQUEST_HUNG", 504],
    ["TABLE_BODY_TIMEOUT", 504], ["TABLE_API_REJECTED", 502],
    ["WAF_CHALLENGE", 503], ["SCHEDULE_NOT_PUBLISHED", 409],
    ["HARVEST_TRANSIENT", 503], ["BROWSER_BUSY", 503], ["BROWSER_DEADLINE", 503],
  ])("harvest %s propagates unchanged at HTTP %s without relogin", async (code, status) => {
    const stub = freshStub(`harvest-code-${code}`);
    await seedSession(stub, { status: "active" });
    const alarms = await captureSetAlarm(stub);
    spyBrowserFetch({ "/data-harvest": async () => Response.json({
      ok: false, error: code, diagnostics: { timeline: [] }, state: { secret: "SECRET" },
    }, { status: status as number }) });
    const res = await postHarvest(stub);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toMatchObject({ code });
    expect(body).not.toHaveProperty("diagnostics");
    expect(body).not.toHaveProperty("state");
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(await readStatus(stub)).toBe("active");
    expect(alarms).toHaveLength(0);
  });

  it.each(["throw", "html", "unknown"])("harvest %s is residual, never WAF", async (mode) => {
    const stub = freshStub(`harvest-residual-${mode}`);
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({ "/data-harvest": async () => {
      if (mode === "throw") throw new Error("SECRET browser failure");
      if (mode === "html") return new Response("SECRET non-JSON", { status: 502 });
      return Response.json({ ok: false, error: "SECRET unknown code" }, { status: 502 });
    } });
    const res = await postHarvest(stub);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: "HARVEST_TRANSIENT" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("per-user rate limit exhausted → RATE_LIMITED", async () => {
    const stub = freshStub("harvest-throttle");
    const now = Date.now();
    // 灌满 per-user 窗口(MAX_ST_MINTS_PER_USER=60)。
    const full = Array.from({ length: 60 }, () => ({
      ts: now, clientId: "calendar", host: "my.cqu.edu.cn", broad: false,
    }));
    await seedSession(stub, { status: "active", extra: { stMintLog: full } });
    const spy = spyBrowserFetch({ "/data-harvest": async () => Response.json({}) });

    const res = await postHarvest(stub);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe("RATE_LIMITED");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("external-search action", () => {
  const recipe = {
    action: "admin_class_search",
    departmentId: "",
    departmentName: "",
    grade: "2026",
    keyword: "电气",
  };
  const typedResult = {
    ok: true,
    contractVersion: 1,
    sourceType: "admin_class",
    session: { id: "session-current", name: "2026秋" },
    items: [{ id: "class-1", name: "电气1班", extra: "2026级" }],
    truncated: true,
  };

  async function postSearch(stub: DurableObjectStub, body: unknown = recipe) {
    return stub.fetch("http://do/external-search?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("returns the typed browser result and records one real browser action", async () => {
    const stub = freshStub("external-search-ok");
    await seedSession(stub, { status: "active" });
    let received: Record<string, unknown> | null = null;
    spyBrowserFetch({
      "/external-search": async (request) => {
        received = await request.json() as Record<string, unknown>;
        return Response.json(typedResult);
      },
    });

    const res = await postSearch(stub);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(typedResult);
    expect(received).toMatchObject(recipe);
    expect(typeof received?.["operationTimeoutMs"]).toBe("number");
    expect(received?.["operationTimeoutMs"]).toBeLessThanOrEqual(90_000);
    expect(await readStMintLog(stub)).toHaveLength(1);
  });

  it("rejects malformed fixed recipes before browser dispatch or accounting", async () => {
    const stub = freshStub("external-search-invalid");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/external-search": async () => Response.json({}) });

    const res = await postSearch(stub, { ...recipe, url: "https://example.com" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_SEARCH_RECIPE" });
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("maps browser session expiry without echoing raw diagnostics", async () => {
    const stub = freshStub("external-search-expired");
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({
      "/external-search": async () => Response.json(
        { ok: false, error: "TGT_EXPIRED", diagnostics: { cookie: "SECRET" } },
        { status: 409 },
      ),
    });

    const res = await postSearch(stub);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "TGT_EXPIRED" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("maps school page permission denial without echoing raw diagnostics", async () => {
    const stub = freshStub("external-search-forbidden");
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({
      "/external-search": async () => Response.json(
        { ok: false, error: "PAGE_PERMISSION_DENIED", diagnostics: { cookie: "SECRET" } },
        { status: 403 },
      ),
    });

    const res = await postSearch(stub);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: "PAGE_PERMISSION_DENIED" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});

describe("external-directory action", () => {
  const recipe = {
    kind: "instructors",
    classIds: ["740923", "744669"],
    expectedSessionId: "session-current",
  };
  const typedResult = {
    ok: true,
    contractVersion: 1,
    kind: "instructors",
    session: { id: "session-current", name: "2026秋" },
    classes: [
      {
        classId: "740923",
        items: [{ id: "teacher-1", name: "张三", extra: "10001 / 软件学院", departmentId: "dept-1" }],
      },
      { classId: "744669", items: [] },
    ],
  };

  async function postDirectory(stub: DurableObjectStub, body: unknown = recipe) {
    return stub.fetch("http://do/external-directory?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("dispatches one bounded browser batch and records one real browser action", async () => {
    const stub = freshStub("external-directory-ok");
    await seedSession(stub, { status: "active" });
    let received: Record<string, unknown> | null = null;
    spyBrowserFetch({
      "/external-directory": async (request) => {
        received = await request.json() as Record<string, unknown>;
        return Response.json(typedResult);
      },
    });

    const res = await postDirectory(stub);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(typedResult);
    expect(received).toMatchObject(recipe);
    expect(received).not.toHaveProperty("deadlineAt");
    expect(received?.["state"]).toEqual(validStorageState());
    expect(typeof received?.["operationTimeoutMs"]).toBe("number");
    expect(received?.["operationTimeoutMs"]).toBeLessThanOrEqual(70_000);
    expect(await readStMintLog(stub)).toHaveLength(1);
  });

  it("rejects malformed fixed recipes before browser dispatch or accounting", async () => {
    const stub = freshStub("external-directory-invalid");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/external-directory": async () => Response.json({}) });

    const res = await postDirectory(stub, { ...recipe, url: "https://example.com" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_DIRECTORY_RECIPE" });
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("maps an unverifiable current page term without echoing raw diagnostics", async () => {
    const stub = freshStub("external-directory-term-unverified");
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({
      "/external-directory": async () => Response.json(
        { ok: false, error: "CURRENT_SESSION_UNVERIFIED", diagnostics: { cookie: "SECRET" } },
        { status: 409 },
      ),
    });

    const res = await postDirectory(stub);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "CURRENT_SESSION_UNVERIFIED" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(await readStatus(stub)).toBe("active");
  });

  it("serializes a directory batch against neighboring external search", async () => {
    const stub = freshStub("external-directory-shared-flight");
    await seedSession(stub, { status: "active" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    spyBrowserFetch({
      "/external-directory": async () => {
        await gate;
        return Response.json(typedResult);
      },
    });

    const directory = postDirectory(stub);
    await new Promise(resolve => setTimeout(resolve, 20));
    const search = await stub.fetch("http://do/external-search?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify({
        action: "admin_class_search",
        departmentId: "",
        departmentName: "",
        grade: "",
        keyword: "电气",
      }),
    });
    expect(search.status).toBe(503);
    await expect(search.json()).resolves.toMatchObject({ code: "BROWSER_BUSY" });
    release();
    expect((await directory).status).toBe(200);
  });

  it("does not return directory data after the binding changes", async () => {
    const stub = freshStub("external-directory-binding-changed");
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({
      "/external-directory": async () => {
        await env.DATABASE.prepare("UPDATE cqu_bind_addresses SET status = 'deleting' WHERE user_id = 'u1'").run();
        return Response.json(typedResult);
      },
    });

    const res = await postDirectory(stub);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "SESSION_INACTIVE" });
  });
});

describe("external-capture action", () => {
  const recipe = {
    action: "admin_class_capture",
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气工程2026-01班",
    expectedSessionId: "",
  };
  const typedResult = {
    ok: true,
    contractVersion: 1,
    sourceType: "admin_class",
    target: { id: "class-1", name: "电气工程2026-01班" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [{
        courseName: "高等数学",
        assignTeachingObject: [{ adminClassId: "class-1" }],
      }],
      maxSection: 12,
    },
  };

  async function postCapture(stub: DurableObjectStub, body: unknown = recipe) {
    return stub.fetch("http://do/external-capture?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("dispatches one bounded browser action and returns the typed capture", async () => {
    const stub = freshStub("external-capture-ok");
    await seedSession(stub, { status: "active" });
    let received: Record<string, unknown> | null = null;
    spyBrowserFetch({
      "/external-capture": async (request) => {
        received = await request.json() as Record<string, unknown>;
        return Response.json(typedResult);
      },
    });

    const res = await postCapture(stub, { ...recipe, deadlineAt: Date.now() + 90_000 });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(typedResult);
    expect(received).toMatchObject(recipe);
    expect(received).not.toHaveProperty("deadlineAt");
    expect(typeof received?.["operationTimeoutMs"]).toBe("number");
    expect(received?.["operationTimeoutMs"]).toBeLessThanOrEqual(70_000);
    expect(received?.["state"]).toEqual(validStorageState());
    expect(await readStMintLog(stub)).toHaveLength(1);
  });

  it("rejects transport overrides before browser dispatch or accounting", async () => {
    const stub = freshStub("external-capture-invalid");
    await seedSession(stub, { status: "active" });
    const spy = spyBrowserFetch({ "/external-capture": async () => Response.json({}) });

    const res = await postCapture(stub, { ...recipe, selector: "#target" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_CAPTURE_RECIPE" });
    expect(spy).not.toHaveBeenCalled();
    expect(await readStMintLog(stub)).toHaveLength(0);
  });

  it("maps expiry and permission failures without echoing raw diagnostics", async () => {
    const expired = freshStub("external-capture-expired");
    await seedSession(expired, { status: "active" });
    spyBrowserFetch({
      "/external-capture": async () => Response.json(
        { ok: false, error: "TGT_EXPIRED", diagnostics: { cookie: "SECRET" } },
        { status: 409 },
      ),
    });
    const expiredRes = await postCapture(expired);
    expect(expiredRes.status).toBe(409);
    await expect(expiredRes.json()).resolves.toMatchObject({ code: "TGT_EXPIRED" });
    expect(await readStatus(expired)).toBe("expired");

    const denied = freshStub("external-capture-denied");
    await seedSession(denied, { status: "active" });
    spyBrowserFetch({
      "/external-capture": async () => Response.json(
        { ok: false, error: "PAGE_PERMISSION_DENIED", diagnostics: { bearer: "SECRET" } },
        { status: 403 },
      ),
    });
    const deniedRes = await postCapture(denied);
    expect(deniedRes.status).toBe(403);
    const body = await deniedRes.json();
    expect(body).toMatchObject({ code: "PAGE_PERMISSION_DENIED" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(await readStatus(denied)).toBe("active");
  });

  it("rejects overlapping same-user captures as BROWSER_BUSY", async () => {
    const stub = freshStub("external-capture-single-flight");
    await seedSession(stub, { status: "active" });
    let release!: (value: void) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = spyBrowserFetch({
      "/external-capture": async () => {
        await gate;
        return Response.json(typedResult);
      },
    });

    const first = postCapture(stub);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await postCapture(stub);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toMatchObject({ code: "BROWSER_BUSY" });
    release();
    expect((await first).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(["AMBIGUOUS_TARGET", "CURRENT_SESSION_CHANGED"])("keeps the login active for business conflict %s", async code => {
    const stub = freshStub(`external-capture-${code}`);
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({ "/external-capture": async () => Response.json({ ok: false, error: code }, { status: 409 }) });
    const response = await postCapture(stub);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(await readStatus(stub)).toBe("active");
  });

  it("serializes search against an in-flight capture for the same user", async () => {
    const stub = freshStub("external-browser-shared-flight");
    await seedSession(stub, { status: "active" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    spyBrowserFetch({ "/external-capture": async () => { await gate; return Response.json(typedResult); } });
    const capture = postCapture(stub);
    await new Promise(resolve => setTimeout(resolve, 20));
    const search = await stub.fetch("http://do/external-search?clientId=calendar&source=rpc", {
      method: "POST", body: JSON.stringify({ action: "departments", sourceType: "admin_class" }),
    });
    expect(search.status).toBe(503);
    await expect(search.json()).resolves.toMatchObject({ code: "BROWSER_BUSY" });
    release();
    expect((await capture).status).toBe(200);
  });

  it("does not return browser data after the binding changes", async () => {
    const stub = freshStub("external-capture-binding-changed");
    await seedSession(stub, { status: "active" });
    spyBrowserFetch({
      "/external-capture": async () => {
        await env.DATABASE.prepare("UPDATE cqu_bind_addresses SET status = 'deleting' WHERE user_id = 'u1'").run();
        return Response.json(typedResult);
      },
    });

    const res = await postCapture(stub);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "SESSION_INACTIVE" });
  });
});
