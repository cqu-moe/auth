import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { CquLoginContainer } from "../../src/durable-objects/cqu-login-container";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

it.each([false, true])("protects startup, code waiting and streaming, then stops (warm=%s)", async (warm) => {
  vi.useFakeTimers();
  const stub = env.CQU_QUICKLOGIN_DEVICE.get(env.CQU_QUICKLOGIN_DEVICE.newUniqueId());
  await runInDurableObject(stub, async (_instance, context) => {
    const entered = Promise.withResolvers<void>();
    const starting = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const loginResult = Promise.withResolvers<Response>();
    const runtime = {
      running: false,
      start: () => { runtime.running = true; },
      monitor: () => new Promise<void>(() => {}),
      signal: vi.fn(() => { runtime.running = false; }),
      getTcpPort: () => ({
        fetch: async (url: string) => {
          if (new URL(url).hostname === "containerstarthealthcheck") {
            starting.resolve();
            await started.promise;
          }
          if (new URL(url).pathname === "/run") {
            entered.resolve();
            return loginResult.promise;
          }
          return new Response(null, { status: 204 });
        },
      }),
    };
    const initialization: Promise<unknown>[] = [];
    // Use the real SDK and DO storage; replace only the unavailable container
    // transport and automatic alarm dispatch.
    Object.defineProperty(context, "container", { value: runtime, configurable: true });
    vi.spyOn(context.storage, "setAlarm").mockResolvedValue();
    vi.spyOn(context, "blockConcurrencyWhile").mockImplementation((callback) => {
      const pending = Promise.resolve().then(callback);
      initialization.push(pending);
      return pending;
    });
    await context.storage.put("__CF_CONTAINER_STATE", { status: warm ? "healthy" : "stopped", lastChange: Date.now() });
    const container = new CquLoginContainer(context as ConstructorParameters<typeof CquLoginContainer>[0], env);
    await Promise.all(initialization);
    runtime.running = warm;

    const login = container.fetch(new Request("http://container/run", { method: "POST" }));
    if (!warm) {
      await starting.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      const startupAlarm = container.alarm();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.signal).not.toHaveBeenCalled();
      started.resolve();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(28_000);
      await startupAlarm;
    }
    await entered.promise;
    const checkStillBusy = async () => {
      vi.setSystemTime(Date.now() + 120_000);
      const alarm = container.alarm();
      await vi.advanceTimersByTimeAsync(30_000);
      await alarm;
      expect(runtime.signal).not.toHaveBeenCalled();
    };
    await checkStillBusy();

    const code = await container.fetch(new Request("http://container/code", { method: "POST" }));
    expect(code.status).toBe(204);
    await checkStillBusy();

    // An alarm already waiting on the old 30s deadline must be woken up.
    const oldAlarm = container.alarm();
    await vi.advanceTimersByTimeAsync(0);
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    loginResult.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
    })));
    const response = await login;
    await oldAlarm;
    const body = response.text();
    bodyController.enqueue(new TextEncoder().encode("login complete"));
    await checkStillBusy();
    bodyController.close();
    await expect(body).resolves.toBe("login complete");
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(Date.now() + 1_001);
    await container.alarm();
    expect(runtime.signal).toHaveBeenCalledExactlyOnceWith(15);
  });
});
