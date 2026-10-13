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
    vi.stubEnv("VITE_POSTHOG_ALLOW_NON_PRODUCTION", "true");
    document.cookie = "ph_test_posthog=legacy; Path=/";
    const telemetry = await import("./posthog");
    const init = vi.spyOn(telemetry.posthog, "init").mockReturnValue(telemetry.posthog);

    expect(telemetry.initPostHog()).toBe(true);
    expect(init).toHaveBeenCalledWith("test", expect.objectContaining({
      api_host: "https://p.cqu.moe",
      asset_host: "https://p.cqu.moe",
      ui_host: "https://us.posthog.com",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      capture_pageview: false,
      autocapture: false,
      disable_session_recording: true,
    }));
    expect(document.cookie).not.toContain("ph_test_posthog");
  });
});
