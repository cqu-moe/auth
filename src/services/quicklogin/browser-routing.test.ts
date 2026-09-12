import { describe, expect, it } from "vitest";
import {
  quickloginContainerKey,
  quickloginBrowserRoute,
} from "./browser-routing";

describe("quicklogin browser routing", () => {
  it("uses a distinct server-owned container key per device", () => {
    expect(quickloginContainerKey("user-1", "device-a")).toBe(
      "quicklogin:user-1:device-a"
    );
    expect(quickloginContainerKey("user-1", "device-a")).not.toBe(
      quickloginContainerKey("user-1", "device-b")
    );
  });

  it("keeps the real Auth owner separate from the container key", () => {
    expect(quickloginBrowserRoute("user-1", "device-a")).toEqual({
      version: 1,
      backend: "cloudflare",
      userId: "user-1",
      containerKey: "quicklogin:user-1:device-a",
    });
  });

  it("rejects identifiers that could make container keys ambiguous", () => {
    expect(() => quickloginContainerKey("", "device-a")).toThrowError(
      "INVALID_REQUEST"
    );
    expect(() => quickloginContainerKey("user-1", "device:a")).toThrowError(
      "INVALID_REQUEST"
    );
  });
});
