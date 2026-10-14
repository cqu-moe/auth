import { describe, expect, it, vi } from "vitest";
import { classifyNodeExternalCaptureResponse } from "./cqu-node-protocol";
import { fetchBrowser, type BrowserRoute } from "./cqu-browser-routing";

describe("fetchBrowser transport", () => {
  const nodeRoute: BrowserRoute = { version: 1, backend: "node", userId: "user-a" };
  const cfRoute: BrowserRoute = { version: 1, backend: "cloudflare", userId: "user-a" };

  function makeEnv(containerFetch: unknown, idFromName = vi.fn(() => "stable-id")) {
    return {
      CQU_LOGIN: {
        idFromName,
        get: vi.fn().mockReturnValue({ fetch: containerFetch }),
      },
    };
  }

  it("returns a controlled terminal response for stale node routes without touching CQU_LOGIN", async () => {
    const env = makeEnv(vi.fn());
    const request = new Request("http://cqu-login.internal/run", { method: "POST" });
    const response = await fetchBrowser(env as never, nodeRoute, request);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ ok: false, error: "NODE_RETIRED" });
    expect((env as { CQU_LOGIN: { idFromName: unknown } }).CQU_LOGIN.idFromName).not.toHaveBeenCalled();
  });

  it("addresses the same user container across repeated calls and separates users", async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response("cf ok"));
    const idFromName = vi.fn((userId: string) => `id:${userId}`);
    const env = makeEnv(containerFetch, idFromName);
    const stubs = (env as never as { CQU_LOGIN: { get: ReturnType<typeof vi.fn> } }).CQU_LOGIN.get;
    await fetchBrowser(env as never, cfRoute, new Request("http://cqu-login.internal/run"));
    await fetchBrowser(env as never, cfRoute, new Request("http://cqu-login.internal/keepalive"));
    await fetchBrowser(env as never, { ...cfRoute, userId: "user-b" }, new Request("http://cqu-login.internal/run"));
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["user-a", "user-a", "user-b"]);
    expect(stubs.mock.calls.map((c) => String(c[0]))).toEqual(["id:user-a", "id:user-a", "id:user-b"]);
    expect(containerFetch).toHaveBeenCalledTimes(3);
  });

  it("addresses a quicklogin container by containerKey without changing route ownership", async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response("cf ok"));
    const idFromName = vi.fn((key: string) => `id:${key}`);
    const env = makeEnv(containerFetch, idFromName);
    const route: BrowserRoute = {
      ...cfRoute,
      userId: "user-a",
      containerKey: "quicklogin:user-a:device-a",
    };

    await fetchBrowser(
      env as never,
      route,
      new Request("http://cqu-login.internal/run")
    );

    expect(idFromName).toHaveBeenCalledWith("quicklogin:user-a:device-a");
    expect(route.userId).toBe("user-a");
  });

  it("preserves method, body and signal on the forwarded request", async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const env = makeEnv(containerFetch);
    const controller = new AbortController();
    const request = new Request("http://login-node.internal/code", {
      method: "POST",
      body: JSON.stringify({ token: "tok", code: "123456" }),
      signal: controller.signal,
    });
    await fetchBrowser(env as never, cfRoute, request);
    const forwarded = containerFetch.mock.calls[0][0] as Request;
    expect(forwarded).toBe(request);
    expect(forwarded.method).toBe("POST");
    // Request 构造会派生依赖 signal;断言 abort 语义而非对象同一性。
    expect(forwarded.signal.aborted).toBe(false);
    controller.abort("budget elapsed");
    expect(forwarded.signal.aborted).toBe(true);
    expect(forwarded.signal.reason).toBe("budget elapsed");
    expect(await forwarded.clone().text()).toBe(JSON.stringify({ token: "tok", code: "123456" }));
  });

  it("leaves harvest non-JSON capacity responses to the residual classifier without fallback", async () => {
    const busyFetch = vi.fn().mockResolvedValue(new Response("capacity", { status: 503 }));
    const env = makeEnv(busyFetch);
    const response = await fetchBrowser(env as never, cfRoute, new Request("http://cqu-login.internal/data-harvest", { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("capacity");
    expect(busyFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["SCHEMA_INVALID", "CURRENT_SESSION_CHANGED"])(
    "returns external-capture contract error %s from a capacity response",
    async (error) => {
      const captureFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      );
      const env = makeEnv(captureFetch);
      const response = await fetchBrowser(
        env as never,
        cfRoute,
        new Request("http://cqu-login.internal/external-capture", { method: "POST" })
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, error });
      expect(captureFetch).toHaveBeenCalledTimes(1);
    }
  );

  it("leaves external-capture platform capacity responses to the residual classifier", async () => {
    const env = makeEnv(vi.fn().mockResolvedValue(new Response("capacity", { status: 503 })));
    const response = await fetchBrowser(
      env as never,
      cfRoute,
      new Request("http://cqu-login.internal/external-capture", { method: "POST" })
    );

    expect(response.status).toBe(503);
    await expect(response.clone().text()).resolves.toBe("capacity");
    expect(
      classifyNodeExternalCaptureResponse(response.status, await response.json().catch(() => null))
    ).toEqual({ kind: "transient", code: "CAPTURE_TRANSIENT" });
  });

  it("treats a 429 platform response as capacity pressure", async () => {
    const env = makeEnv(vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));
    await expect(
      fetchBrowser(env as never, cfRoute, new Request("http://cqu-login.internal/run", { method: "POST" }))
    ).rejects.toMatchObject({ code: "BROWSER_BUSY" });
  });

  it("preserves a known stable protocol error code from a capacity response", async () => {
    const env = makeEnv(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "BROWSER_DEADLINE" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      )
    );
    await expect(
      fetchBrowser(env as never, cfRoute, new Request("http://cqu-login.internal/run", { method: "POST" }))
    ).rejects.toMatchObject({ code: "BROWSER_DEADLINE" });
  });

  it("maps a protocol-shaped response with an unknown error to BROWSER_BUSY without echoing it", async () => {
    const env = makeEnv(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "TOTALLY_NEW_PLATFORM_CODE" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const rejection = await fetchBrowser(
      env as never,
      cfRoute,
      new Request("http://cqu-login.internal/run", { method: "POST" })
    ).catch((e: unknown) => e);
    expect(rejection).toMatchObject({ code: "BROWSER_BUSY" });
    expect((rejection as Error).message).not.toContain("TOTALLY_NEW_PLATFORM_CODE");
  });

  it("cancels an unread platform capacity body before reporting BROWSER_BUSY", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("platform text"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const env = makeEnv(vi.fn().mockResolvedValue(new Response(stream, { status: 503 })));
    await expect(
      fetchBrowser(env as never, cfRoute, new Request("http://cqu-login.internal/run", { method: "POST" }))
    ).rejects.toMatchObject({ code: "BROWSER_BUSY" });
    expect(cancelled).toBe(true);
  });

  it("returns non-capacity responses for call-site classification", async () => {
    const bootMismatch = new Response(
      JSON.stringify({ ok: false, error: "BROWSER_INSTANCE_REPLACED" }),
      { status: 409, headers: { "content-type": "application/json" } }
    );
    const env = makeEnv(vi.fn().mockResolvedValue(bootMismatch));
    const response = await fetchBrowser(
      env as never,
      cfRoute,
      new Request("http://cqu-login.internal/code", { method: "POST" })
    );
    expect(response.status).toBe(409);
  });
});
