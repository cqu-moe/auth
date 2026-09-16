// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

describe("browser PostHog persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses localStorage only and removes the legacy PostHog cookie", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "test");
    document.cookie = "ph_test_posthog=legacy; Path=/";
    const telemetry = await import("./posthog");
    const init = vi.spyOn(telemetry.posthog, "init").mockReturnValue(telemetry.posthog);

    expect(telemetry.initPostHog()).toBe(true);
    expect(init).toHaveBeenCalledWith("test", expect.objectContaining({
      persistence: "localStorage",
      cross_subdomain_cookie: false,
    }));
    expect(document.cookie).not.toContain("ph_test_posthog");
  });
});
