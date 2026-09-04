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
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, afterEach, vi } from "vitest";
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
  spyLoginNode,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verification-code lease orchestration", () => {
  it("deposit-code sends the code only to the lease owner token", async () => {
    const stub = freshStub("code-lease-owner");
    await seedSession(stub, {
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
    spyLoginNode({
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

  it("releasing the owner promotes FIFO head and grants only it a fresh permit", async () => {
    const stub = freshStub("code-lease-promote");
    await seedSession(stub, {
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
    spyLoginNode({
      "/code-permit": async (request) => {
        permits.push(await request.json());
        return Response.json({ ok: true });
      },
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        releaseVerificationCodeLease: (token: string) => Promise<void>;
      }).releaseVerificationCodeLease("cas-1");
    });

    expect(permits).toEqual([{ session: "atrust-1" }]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      ownerKind: "atrust",
      queue: [],
    });
  });

  it("retries a transient permit failure before handing the promoted owner control", async () => {
    const stub = freshStub("code-lease-permit-retry");
    await seedSession(stub, {
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
    spyLoginNode({
      "/code-permit": async () => {
        attempts += 1;
        return Response.json(
          { ok: attempts >= 3 },
          { status: attempts >= 3 ? 200 : 502 }
        );
      },
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        releaseVerificationCodeLease: (token: string) => Promise<void>;
      }).releaseVerificationCodeLease("cas-1");
    });

    expect(attempts).toBe(3);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("keeps a promoted owner fenced when every permit acknowledgement is lost", async () => {
    const stub = freshStub("code-lease-permit-terminal-failure");
    await seedSession(stub, {
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
    spyLoginNode({
      "/code-permit": async () =>
        Response.json({ ok: false }, { status: 502 }),
    });

    await runInDurableObject(stub, async (instance) => {
      await expect(
        (instance as unknown as {
          releaseVerificationCodeLease: (token: string) => Promise<void>;
        }).releaseVerificationCodeLease("cas-1")
      ).rejects.toThrow("code-permit failed");
    });

    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      ownerKind: "atrust",
      queue: [],
    });
    expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
  });

  it("never promotes a successor when the node accepted a permit but every response was lost", async () => {
    const stub = freshStub("code-lease-permit-accepted-response-lost");
    await seedSession(stub, {
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
    spyLoginNode({
      "/code-permit": async (request) => {
        const body = await request.json<{ session: string }>();
        accepted.push(body.session);
        throw new Error("response lost after accept");
      },
    });

    await runInDurableObject(stub, async (instance) => {
      await expect(
        (instance as unknown as {
          releaseVerificationCodeLease: (token: string) => Promise<void>;
        }).releaseVerificationCodeLease("cas-1")
      ).rejects.toThrow("code-permit failed");
    });

    expect(accepted).toEqual(["atrust-1", "atrust-1", "atrust-1"]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      queue: [{ token: "cas-2", kind: "cas" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
  });

  it("does not promote a pending owner even when its release retry is acknowledged", async () => {
    const stub = freshStub("code-lease-pending-release");
    await seedSession(stub, {
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
    const permit = spyLoginNode({
      "/code-permit": async () => Response.json({ ok: true }),
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        releaseVerificationCodeLease: (token: string) => Promise<void>;
      }).releaseVerificationCodeLease("atrust-1");
    });

    expect(permit).toHaveBeenCalledTimes(1);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      queue: [{ token: "cas-2", kind: "cas" }],
    });
    expect(await readStorage(stub, "codePermitPending")).toBeUndefined();
  });

  it("replays a persisted permit marker after activation and commits only its acknowledgement", async () => {
    const stub = freshStub("code-lease-pending-recovery");
    await seedSession(stub, {
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
    spyLoginNode({
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
    await seedSession(stub, {
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
    spyLoginNode({
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

  it("same-owner release replays an uncertain permit but keeps the owner fenced", async () => {
    const stub = freshStub("code-lease-pending-release-replay");
    await seedSession(stub, {
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
    spyLoginNode({
      "/code-permit": async (request) => {
        permits.push((await request.json<{ session: string }>()).session);
        return Response.json({ ok: true });
      },
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        releaseVerificationCodeLease: (token: string) => Promise<void>;
      }).releaseVerificationCodeLease("atrust-1");
    });

    expect(permits).toEqual(["atrust-1"]);
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "atrust-1",
      queue: [{ token: "cas-2", kind: "cas" }],
    });
  });

  it("treats code proof published during a lost acknowledgement as confirmed permit evidence", async () => {
    const stub = freshStub("code-lease-marker-proof-during-grant");
    await seedSession(stub, {
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
      spyLoginNode({
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
    await seedSession(stub, {
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
    spyLoginNode({
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
    await seedSession(stub, {
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
    spyLoginNode({
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
    await seedSession(stub, {
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
    spyLoginNode({
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

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        releaseVerificationCodeLease: (token: string) => Promise<void>;
      }).releaseVerificationCodeLease("cas-1");
    });

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

  it("resetting aTrust removes only aTrust lease entries and preserves direct CAS", async () => {
    const stub = freshStub("code-lease-reset-atrust");
    await seedSession(stub, {
      extra: {
        atrustSession: {
          status: "active",
          storageState: validAtrustStorageState(),
          loginAt: Date.now(),
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
        atrustLoginInFlight: { token: "atrust-1", startedAt: Date.now() },
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
    const spy = spyLoginNode({});

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        resetAtrustAuthState: () => Promise<void>;
      }).resetAtrustAuthState();
    });

    expect(await readStorage(stub, "atrustSession")).toBeUndefined();
    expect(await readStorage(stub, "atrustLoginInFlight")).toBeUndefined();
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: "cas-1",
      ownerKind: "cas",
      queue: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["reset", "revoke", "destroy"] as const)(
    "%s preserves an unexpired owner fence while invalidating login state",
    async (operation) => {
      const stub = freshStub(`code-lease-lifecycle-${operation}`);
      await seedSession(stub, {
        status: "active",
        extra: {
          atrustSession: {
            status: "active",
            storageState: validAtrustStorageState(),
            loginAt: Date.now(),
            lastUsedAt: 0,
            consecutiveFailures: 0,
          },
          codeLease: {
            ownerToken: "atrust-1",
            ownerKind: "atrust",
            acquiredAt: Date.now(),
            queue: [{ token: "cas-2", kind: "cas", queuedAt: Date.now() }],
          },
          codePermitPending: "atrust-1",
        },
      });

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          resetAtrustAuthState: () => Promise<string>;
          revoke: () => Promise<void>;
          destroy: () => Promise<void>;
        };
        if (operation === "reset") await target.resetAtrustAuthState();
        if (operation === "revoke") await target.revoke();
        if (operation === "destroy") await target.destroy();
      });

      expect(await readStorage(stub, "codeLease")).toMatchObject({
        ownerToken: "atrust-1",
      });
      expect(await readStorage(stub, "codePermitPending")).toBe("atrust-1");
      if (operation === "destroy") {
        expect(await readStatus(stub)).toBe("unbound");
      }
      if (operation === "revoke") {
        expect(await readStatus(stub)).toBe("revoked");
      }
    }
  );
});

function pathsOf(spy: ReturnType<typeof spyLoginNode>): string[] {
  return spy.mock.calls.map((c) => {
    const input = c[0] as RequestInfo | URL;
    const url = input instanceof Request ? input.url : String(input);
    return new URL(url).pathname;
  });
}

// ── 1. M7 防复活 ────────────────────────────────────────────────────────────
describe("M7 anti-resurrection", () => {
  it("status flipped to revoked while keepalive probe in flight → not resurrected (no active writeback / no alarm)", async () => {
    const stub = freshStub("m7-revoke");
    await seedSession(stub, { status: "active" });

    await driveAlarmWith(stub, async (_inst, state) => {
      // keepalive 探活返回 alive, 但出站在途期间把 status 改成 revoked(同 DO 上下文写盘,
      // 模拟 admin revoke 在 alarm await LOGIN_NODE.fetch 期间落盘)。
      spyLoginNode({
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
      spyLoginNode({
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

    const spy = spyLoginNode({
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

    const spy = spyLoginNode({
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
  it("service-ticket node 502 → WAF_CHALLENGE (500 fallback), status unchanged, no immediate alarm, no relogin", async () => {
    const stub = freshStub("transient-502");
    await seedSession(stub, { status: "active" });
    const setAlarmCalls = await captureSetAlarm(stub);

    const spy = spyLoginNode({
      "/service-ticket": async () => Response.json({ ok: false }, { status: 502 }),
    });

    const res = await stub.fetch(
      "http://do/service-ticket?service=jwxt&source=route",
      { method: "POST" }
    );

    // transient → WAF_CHALLENGE 不在 CODE_TO_STATUS → fallback 500(服务端/瞬态, 调用方该退避重试)。
    expect(res.status).toBe(500);
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

    const spy = spyLoginNode({
      "/service-ticket": async () => {
        // 模拟 AbortSignal.timeout 触发 / VPC 网络层异常。
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });

    const res = await stub.fetch(
      "http://do/service-ticket?service=jwxt&source=route",
      { method: "POST" }
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WAF_CHALLENGE");
    expect(pathsOf(spy)).toEqual(["/service-ticket"]);
    expect(await readStatus(stub)).toBe("active");
    expect(setAlarmCalls).toHaveLength(0);
  });

  it("keepalive probe unreachable (node 502) → session kept, status active, backed-off alarm (not immediate), no relogin, no ST mint", async () => {
    const stub = freshStub("transient-keepalive");
    await seedSession(stub, { status: "active" });

    const spy = spyLoginNode({
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

    const spy = spyLoginNode({
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

    spyLoginNode({
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

  const atrustRecipe = {
    navUrl:
      "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum",
    capture: ["student/my-table-detail"],
    fetch: [
      {
        method: "GET",
        url: "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/api/exam/x",
      },
    ],
  };

  async function postAtrustHarvest(stub: DurableObjectStub) {
    return stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", {
      method: "POST",
      body: JSON.stringify(atrustRecipe),
    });
  }

  it("active session + node 200 → returns captures/fetches, records 1 ST mint, audits", async () => {
    const stub = freshStub("harvest-ok");
    await seedSession(stub, { status: "active" });

    spyLoginNode({
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

  it("aTrust harvest reuses its independent state even while direct CAS is expired", async () => {
    const stub = freshStub("atrust-reuse");
    const atrustState = validAtrustStorageState("saved");
    await seedSession(stub, {
      status: "expired",
      extra: {
        atrustSession: {
          status: "active",
          storageState: atrustState,
          loginAt: Date.now() - 60_000,
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
      },
    });

    let receivedState: unknown;
    const spy = spyLoginNode({
      "/data-harvest": async (request) => {
        receivedState = ((await request.json()) as { state?: unknown }).state;
        return Response.json({ ok: true, captures: [], fetches: [] });
      },
    });

    const response = await postAtrustHarvest(stub);
    expect(response.status).toBe(200);
    expect(receivedState).toEqual(atrustState);
    expect(pathsOf(spy)).toEqual(["/data-harvest"]);
    expect(await readStatus(stub)).toBe("expired");
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
    expect(
      (await readStorage<{ lastUsedAt: number }>(stub, "atrustSession"))
        ?.lastUsedAt
    ).toBeGreaterThan(0);
  });

  it("does not resurrect aTrust after revoke invalidates an in-flight expired harvest", async () => {
    const stub = freshStub("atrust-revoke-no-resurrect");
    await seedSession(stub, {
      status: "active",
      extra: {
        atrustGeneration: "generation-before-revoke",
        atrustSession: {
          status: "active",
          storageState: validAtrustStorageState("stale"),
          loginAt: Date.now() - 60_000,
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
      },
    });
    await seedCredentials(stub);

    let instanceState: DurableObjectState | null = null;
    const spy = spyLoginNode({
      "/data-harvest": async () => {
        await instanceState!.storage.put({
          status: "revoked",
          atrustGeneration: "generation-after-revoke",
        });
        await instanceState!.storage.delete("atrustSession");
        return Response.json(
          { ok: false, error: "ATRUST_SESSION_EXPIRED" },
          { status: 409 }
        );
      },
      "/atrust-login": async () =>
        Response.json({
          ok: true,
          state: validAtrustStorageState("must-not-be-written"),
        }),
      "/code-permit": async () => Response.json({ ok: true }),
    });

    await runInDurableObject(stub, async (instance, state) => {
      instanceState = state;
      await expect(
        (instance as unknown as {
          dataHarvest: (args: unknown) => Promise<unknown>;
        }).dataHarvest({
          recipe: atrustRecipe,
          clientId: "calendar",
          source: "rpc",
        })
      ).rejects.toMatchObject({ code: "SESSION_INACTIVE" });
    });

    expect(pathsOf(spy)).toEqual(["/data-harvest"]);
    expect(await readStorage(stub, "atrustSession")).toBeUndefined();
    expect(await readStatus(stub)).toBe("revoked");
  });

  it("does not let an older successful harvest overwrite a newer aTrust generation", async () => {
    const stub = freshStub("atrust-stale-success-no-overwrite");
    const staleState = validAtrustStorageState("stale");
    const newestState = validAtrustStorageState("newest");
    await seedSession(stub, {
      status: "active",
      extra: {
        atrustGeneration: "generation-old",
        atrustSession: {
          status: "active",
          storageState: staleState,
          loginAt: Date.now() - 60_000,
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
      },
    });

    let instanceState: DurableObjectState | null = null;
    spyLoginNode({
      "/data-harvest": async () => {
        await instanceState!.storage.put({
          atrustGeneration: "generation-new",
          atrustSession: {
            status: "active",
            storageState: newestState,
            loginAt: Date.now(),
            lastUsedAt: 123,
            consecutiveFailures: 0,
          },
        });
        return Response.json({ ok: true, captures: [], fetches: [] });
      },
    });

    await runInDurableObject(stub, async (instance, state) => {
      instanceState = state;
      await expect(
        (instance as unknown as {
          dataHarvest: (args: unknown) => Promise<unknown>;
        }).dataHarvest({
          recipe: atrustRecipe,
          clientId: "calendar",
          source: "rpc",
        })
      ).rejects.toMatchObject({ code: "ATRUST_TRANSIENT" });
    });

    expect(
      (await readStorage<{ storageState: unknown; lastUsedAt: number }>(
        stub,
        "atrustSession"
      ))
    ).toMatchObject({ storageState: newestState, lastUsedAt: 123 });
  });

  it("missing aTrust state logs in on demand without disturbing a live direct-CAS login lock", async () => {
    const stub = freshStub("atrust-on-demand");
    const directLock = { token: "direct-login", startedAt: Date.now() };
    const atrustState = validAtrustStorageState("fresh");
    await seedSession(stub, {
      status: "active",
      extra: {
        loginInFlight: directLock,
        pendingCode: {
          code: "000000",
          kind: "login_2fa",
          ts: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await seedCredentials(stub);

    const spy = spyLoginNode({
      "/atrust-login": async () =>
        Response.json({ ok: true, state: atrustState }),
      "/code-permit": async () => Response.json({ ok: true }),
      "/code": async (request) => {
        expect(await request.json()).toMatchObject({
          code: "000000",
          reusable: true,
        });
        return Response.json({ ok: true });
      },
      "/data-harvest": async (request) => {
        expect(((await request.json()) as { state?: unknown }).state).toEqual(
          atrustState
        );
        return Response.json({ ok: true, captures: [], fetches: [] });
      },
    });

    const response = await postAtrustHarvest(stub);
    expect(response.status).toBe(200);
    expect(pathsOf(spy)).toEqual([
      "/atrust-login",
      "/code-permit",
      "/code",
      "/data-harvest",
    ]);
    expect(await readStorage(stub, "loginInFlight")).toEqual(directLock);
    expect(await readStorage(stub, "atrustLoginInFlight")).toBeUndefined();
    expect(await readStorage(stub, "codeLease")).toBeUndefined();
    expect(await readStorage(stub, "pendingCode")).toBeUndefined();
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it("expired aTrust state relogs once, retries once, and consumes one rate-limit slot", async () => {
    const stub = freshStub("atrust-recover");
    const oldState = validAtrustStorageState("old");
    const freshState = validAtrustStorageState("fresh");
    await seedSession(stub, {
      status: "active",
      extra: {
        atrustSession: {
          status: "active",
          storageState: oldState,
          loginAt: Date.now() - 60_000,
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
      },
    });
    await seedCredentials(stub);

    let harvestAttempt = 0;
    const spy = spyLoginNode({
      "/data-harvest": async (request) => {
        harvestAttempt += 1;
        const state = ((await request.json()) as { state?: unknown }).state;
        if (harvestAttempt === 1) {
          expect(state).toEqual(oldState);
          return Response.json(
            { ok: false, error: "ATRUST_SESSION_EXPIRED" },
            { status: 409 }
          );
        }
        expect(state).toEqual(freshState);
        return Response.json({ ok: true, captures: [], fetches: [] });
      },
      "/atrust-login": async () =>
        Response.json({ ok: true, state: freshState }),
      "/code-permit": async () => Response.json({ ok: true }),
    });

    const response = await postAtrustHarvest(stub);
    expect(response.status).toBe(200);
    expect(pathsOf(spy).filter((path) => path === "/data-harvest")).toHaveLength(2);
    expect(pathsOf(spy).filter((path) => path === "/atrust-login")).toHaveLength(1);
    expect(await readStMintLog(stub)).toHaveLength(1);
    expect(
      (await readStorage<{ storageState: unknown }>(stub, "atrustSession"))
        ?.storageState
    ).toEqual(freshState);
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it("aTrust recovery never makes a third harvest attempt", async () => {
    const stub = freshStub("atrust-one-retry");
    await seedSession(stub, {
      status: "active",
      extra: {
        atrustSession: {
          status: "active",
          storageState: validAtrustStorageState("old"),
          loginAt: Date.now() - 60_000,
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
      },
    });
    await seedCredentials(stub);

    const spy = spyLoginNode({
      "/data-harvest": async () =>
        Response.json(
          { ok: false, error: "ATRUST_SESSION_EXPIRED" },
          { status: 409 }
        ),
      "/atrust-login": async () =>
        Response.json({ ok: true, state: validAtrustStorageState("fresh") }),
      "/code-permit": async () => Response.json({ ok: true }),
    });

    const response = await postAtrustHarvest(stub);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "ATRUST_SESSION_EXPIRED"
    );
    expect(pathsOf(spy).filter((path) => path === "/data-harvest")).toHaveLength(2);
    expect(pathsOf(spy).filter((path) => path === "/atrust-login")).toHaveLength(1);
    expect(await readStMintLog(stub)).toHaveLength(1);
    expect(await readStorage(stub, "atrustSession")).toBeUndefined();
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it("writes exactly one final aTrust audit record when the logical harvest fails", async () => {
    const stub = freshStub("atrust-failure-audit");
    await seedSession(stub, {
      status: "active",
      extra: {
        atrustGeneration: "audit-generation",
        atrustSession: {
          status: "active",
          storageState: validAtrustStorageState("audit"),
          loginAt: Date.now(),
          lastUsedAt: 0,
          consecutiveFailures: 0,
        },
      },
    });
    spyLoginNode({
      "/data-harvest": async () =>
        Response.json({ ok: false, error: "HARVEST_TRANSIENT" }, { status: 502 }),
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(String(value));
    });

    const response = await postAtrustHarvest(stub);
    expect(response.status).toBe(500);

    const audits = logs
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((entry) => entry.evt === "st_mint");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      host: "my-cqu-edu-cn-s.atrust.cqu.edu.cn",
      attempts: 1,
      recovered: false,
      outcome: "WAF_CHALLENGE",
    });
  });

  it("three explicit aTrust password rejections trip only the aTrust reauth breaker", async () => {
    const stub = freshStub("atrust-password-breaker");
    await seedSession(stub, { status: "active" });
    await seedCredentials(stub);
    const spy = spyLoginNode({
      "/atrust-login": async () =>
        Response.json(
          { ok: false, error: "PASSWORD_REJECTED" },
          { status: 401 }
        ),
      "/code-permit": async () => Response.json({ ok: true }),
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await postAtrustHarvest(stub);
      expect(response.status).toBe(attempt === 3 ? 409 : 503);
      expect(((await response.json()) as { code?: string }).code).toBe(
        attempt === 3 ? "ATRUST_NEEDS_REAUTH" : "ATRUST_TRANSIENT"
      );
    }
    const callsBeforeBlockedRetry = spy.mock.calls.length;
    const blocked = await postAtrustHarvest(stub);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code?: string }).code).toBe(
      "ATRUST_NEEDS_REAUTH"
    );
    expect(spy.mock.calls).toHaveLength(callsBeforeBlockedRetry);
    expect(await readStatus(stub)).toBe("active");
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
    expect(
      (await readStorage<{ consecutiveFailures: number }>(
        stub,
        "atrustSession"
      ))?.consecutiveFailures
    ).toBe(3);
  });

  it("status not active (needs_reauth) → NEEDS_REAUTH error, no node call", async () => {
    const stub = freshStub("harvest-reauth");
    await seedSession(stub, { status: "needs_reauth" });
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

    const res = await postHarvest(stub);
    expect(res.status).toBe(409); // cquErrorHttpStatus(NEEDS_REAUTH)
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("NEEDS_REAUTH");
    expect(spy).not.toHaveBeenCalled();
  });

  it("disallowed navUrl host → INVALID_HARVEST_URL, no node call", async () => {
    const stub = freshStub("harvest-badhost");
    await seedSession(stub, { status: "active" });
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

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
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

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
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

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
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

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
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

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
    const spy = spyLoginNode({
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
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

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
    const spy = spyLoginNode({
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

  it("node 502 → WAF_CHALLENGE (500), status unchanged", async () => {
    const stub = freshStub("harvest-502");
    await seedSession(stub, { status: "active" });
    spyLoginNode({
      "/data-harvest": async () => Response.json({ ok: false }, { status: 502 }),
    });
    const res = await postHarvest(stub);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code?: string }).code).toBe("WAF_CHALLENGE");
    expect(await readStatus(stub)).toBe("active");
  });

  it("per-user rate limit exhausted → RATE_LIMITED", async () => {
    const stub = freshStub("harvest-throttle");
    const now = Date.now();
    // 灌满 per-user 窗口(MAX_ST_MINTS_PER_USER=60)。
    const full = Array.from({ length: 60 }, () => ({
      ts: now, clientId: "calendar", host: "my.cqu.edu.cn", broad: false,
    }));
    await seedSession(stub, { status: "active", extra: { stMintLog: full } });
    const spy = spyLoginNode({ "/data-harvest": async () => Response.json({}) });

    const res = await postHarvest(stub);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe("RATE_LIMITED");
    expect(spy).not.toHaveBeenCalled();
  });
});
