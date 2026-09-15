import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  freshStub,
  readStorage,
  seedCredentials,
  seedSession,
  spyBrowserFetch,
} from "./helpers";

const TOKEN = "failed-after-permit";

async function runFailedLogin(
  mayHaveRequestedCode: boolean,
  withSuccessor: boolean
): Promise<DurableObjectStub> {
  const stub = freshStub(`login-error-stage-${mayHaveRequestedCode}`);
  const now = Date.now();
  await seedSession(stub, {
    status: "expired",
    extra: {
      loginInFlight: {
        token: TOKEN,
        startedAt: now,
        deadlineAt: now + 13 * 60_000,
        browserRouteVersion: 1,
      },
      [`browserRoute:${TOKEN}`]: {
        token: TOKEN,
        kind: "cas",
        route: { version: 1, backend: "cloudflare", userId: "u1" },
        createdAt: now,
        expiresAt: now + 40 * 60_000,
      },
      codeLease: {
        ownerToken: TOKEN,
        ownerKind: "cas",
        acquiredAt: now,
        queue: withSuccessor
          ? [{ token: "successor", kind: "quicklogin", queuedAt: now }]
          : [],
      },
      ...(withSuccessor
        ? {
            "browserRoute:successor": {
              token: "successor",
              kind: "quicklogin",
              route: {
                version: 1,
                backend: "cloudflare",
                userId: "u1",
                bootId: "successor-boot",
              },
              createdAt: now,
              expiresAt: now + 40 * 60_000,
            },
          }
        : {}),
    },
  });
  await seedCredentials(stub);

  await runInDurableObject(stub, async (instance) => {
    await (instance as unknown as { loadState: () => Promise<void> }).loadState();
    spyBrowserFetch({
      "/health": () =>
        Response.json({
          ok: true,
          bootId: "old-boot",
          browserProfile: "cloudflare",
          capabilities: [
            "code-permit",
            "browser-route-v1",
            "operation-deadline-v1",
            "login-cancel-v1",
          ],
        }),
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () =>
        Response.json({ ok: false, error: "failed after permit" }, { status: 503 }),
      "/login-cancel": () =>
        Response.json({
          ok: true,
          stopped: true,
          mayHaveRequestedCode,
        }),
    });

    const outcome = await (
      instance as unknown as {
        containerLogin: (
          ok: "RELOGIN_OK",
          fail: "RELOGIN_FAIL",
          start: undefined,
          deadline: undefined,
          reservation: {
            token: string;
            route: { version: 1; backend: "cloudflare"; userId: string };
          }
        ) => Promise<string>;
      }
    ).containerLogin("RELOGIN_OK", "RELOGIN_FAIL", undefined, undefined, {
      token: TOKEN,
      route: { version: 1, backend: "cloudflare", userId: "u1" },
    });
    expect(outcome).toBe("failed");
  });

  return stub;
}

afterEach(() => vi.restoreAllMocks());

describe("failed login cancellation stage receipt", () => {
  it("removes the failed task lock but keeps its channel fenced when a code may be in flight", async () => {
    const stub = await runFailedLogin(true, true);

    expect(await readStorage(stub, "loginInFlight")).toBeUndefined();
    expect(await readStorage(stub, "codeLease")).toMatchObject({
      ownerToken: TOKEN,
      recoveryFence: true,
      queue: [{ token: "successor", kind: "quicklogin" }],
    });
    expect(await readStorage(stub, "interruptedLogins")).toEqual([
      expect.objectContaining({
        token: TOKEN,
        stopped: true,
        isolationUntil: expect.any(Number),
      }),
    ]);
    expect(await readStorage(stub, "codePermitPending")).not.toBe("successor");
  });

  it("clears the failed task channel when cancellation proves no code was requested", async () => {
    const stub = await runFailedLogin(false, false);

    expect(await readStorage(stub, "loginInFlight")).toBeUndefined();
    expect(await readStorage(stub, "codeLease")).toBeUndefined();
    expect(await readStorage(stub, "interruptedLogins")).toBeUndefined();
    expect(await readStorage(stub, `browserRoute:${TOKEN}`)).toBeUndefined();
  });
});

describe('proactive session recovery', () => {
  it('keeps an already active session usable when proactive login hits transient risk control', async () => {
    const stub = freshStub('proactive-transient');
    await seedSession(stub, {status:'active'});
    await seedCredentials(stub);
    const previous = await readStorage(stub,'state');
    spyBrowserFetch({
      '/health': () => Response.json({ok:true,bootId:'boot-1',browserProfile:'cloudflare',capabilities:['browser-route-v1','operation-deadline-v1']}),
      '/code-permit': () => Response.json({ok:true}),
      '/run': () => Response.json({ok:false,error:'transient: WAF_CHALLENGE'}),
      '/login-cancel': () => Response.json({ok:true,stopped:true,mayHaveRequestedCode:false}),
    });
    await runInDurableObject(stub, async(instance)=>{
      const target=instance as unknown as {loadState():Promise<void>;relogin():Promise<void>};
      await target.loadState(); await target.relogin();
    });
    expect(await readStorage(stub,'status')).toBe('active');
    expect(await readStorage(stub,'state')).toEqual(previous);
    expect(await readStorage<number>(stub,'reloginRetryAt')).toBeGreaterThan(Date.now());
    expect(await readStorage(stub,'credentialFailures')).toBeUndefined();
  });
});
