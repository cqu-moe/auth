import { describe, it, expect } from "vitest";
import { CAPABILITIES, PRESETS, isQuota, isFlag } from "./capabilities";

describe("capabilities catalog", () => {
  it("declares the schedule-aligned calendar flags and quotas (issue #6)", () => {
    expect(isFlag(CAPABILITIES.calendar.sync)).toBe(true);
    expect(isFlag(CAPABILITIES.calendar.external)).toBe(true);
    expect(isFlag(CAPABILITIES.calendar.share)).toBe(true);
    expect(isFlag(CAPABILITIES.calendar.change_notification)).toBe(true);
    expect(isQuota(CAPABILITIES.calendar.sub_limit)).toBe(true);
    expect(isQuota(CAPABILITIES.calendar.share_limit)).toBe(true);
    expect(isQuota(CAPABILITIES.calendar.sync_interval)).toBe(true);
    expect(isQuota(CAPABILITIES.calendar.manual_refresh)).toBe(true);
  });
  it("has cqu.quicklogin opt-in flag for the extension", () => {
    expect(isFlag(CAPABILITIES.cqu.quicklogin)).toBe(true);
    expect(isFlag(CAPABILITIES.cqu.quicklogin_access)).toBe(true);
  });
  it("presets only reference real catalog keys", () => {
    for (const preset of Object.values(PRESETS)) {
      for (const [sub, caps] of Object.entries(preset)) {
        for (const key of Object.keys(caps)) {
          expect((CAPABILITIES as any)[sub]?.[key]).toBeDefined();
        }
      }
    }
  });
});
