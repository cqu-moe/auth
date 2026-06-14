import { describe, it, expect } from "vitest";
import { CAPABILITIES, PRESETS, isQuota, isFlag } from "./capabilities";

describe("capabilities catalog", () => {
  it("declares calendar.sync as a flag and sync_limit as a quota", () => {
    expect(isFlag(CAPABILITIES.calendar.sync)).toBe(true);
    expect(isQuota(CAPABILITIES.calendar.sync_limit)).toBe(true);
  });
  it("has cqu.quicklogin opt-in flag for the extension", () => {
    expect(isFlag(CAPABILITIES.cqu.quicklogin)).toBe(true);
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
