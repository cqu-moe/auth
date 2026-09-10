import { describe, expect, it } from "vitest";
import { quickloginDeviceModeEnabled } from "./mode";

describe("quicklogin device mode", () => {
  it("defaults missing and unknown values to off", () => {
    expect(quickloginDeviceModeEnabled({})).toBe(false);
    expect(quickloginDeviceModeEnabled({ QUICKLOGIN_DEVICE_MODE: "off" })).toBe(false);
    expect(quickloginDeviceModeEnabled({ QUICKLOGIN_DEVICE_MODE: "on" })).toBe(true);
  });
});
