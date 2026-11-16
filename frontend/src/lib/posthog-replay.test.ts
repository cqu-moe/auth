// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://auth.cqu.moe"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "test");
  vi.stubEnv("VITE_POSTHOG_ALLOW_NON_PRODUCTION", "true");
  vi.doMock("posthog-js/dist/posthog-recorder", () => ({}));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("posthog-js/dist/posthog-recorder");
});

async function telemetry() {
  const module = await import("./posthog");
  vi.spyOn(module.posthog, "init").mockReturnValue(module.posthog);
  const start = vi.spyOn(module.posthog, "startSessionRecording").mockImplementation(() => undefined);
  const stop = vi.spyOn(module.posthog, "stopSessionRecording").mockImplementation(() => undefined);
  const capture = vi.spyOn(module.posthog, "captureException").mockImplementation(() => undefined);
  module.initPostHog();
  return { sync: module.syncPostHogReplay, start, stop, capture };
}

it("waits for the recorder module before enabling recording", async () => {
  const { sync, start } = await telemetry();
  const loading = sync("/login");
  expect(start).not.toHaveBeenCalled();
  await loading;
  expect(start).toHaveBeenCalledWith(true);
});

it("keeps recording stopped when disabled while the module is loading", async () => {
  const { sync, start, stop } = await telemetry();
  const loading = sync("/login");
  await sync("");
  await loading;
  expect(stop).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});

it("reports a failed recorder load without rejecting the route effect", async () => {
  vi.doMock("posthog-js/dist/posthog-recorder", () => { throw new Error("chunk unavailable"); });
  const { sync, start, capture } = await telemetry();
  await expect(sync("/login")).resolves.toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(capture).toHaveBeenCalledWith(expect.any(Error), { operation: "load_recorder" });
});
