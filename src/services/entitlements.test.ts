import { describe, it, expect } from "vitest";
import { rowsToCaps, subsystemForAccessToken } from "./entitlements";

describe("rowsToCaps", () => {
  const rows = [
    { subsystem: "calendar", capability: "sync", value: "1" },
    { subsystem: "calendar", capability: "sync_limit", value: "200" },
    { subsystem: "eval", capability: "submit", value: "1" },
  ];
  it("maps flags to booleans and quotas to numbers", () => {
    const caps = rowsToCaps(rows);
    expect(caps.calendar).toEqual({ sync: true, sync_limit: 200, share: false });
    expect(caps.eval).toEqual({ submit: true, batch: false });
  });
  it("can scope to a single subsystem (least-disclosure for JWT)", () => {
    const caps = rowsToCaps(rows, "calendar");
    expect(caps).toEqual({ calendar: { sync: true, sync_limit: 200, share: false } });
    expect((caps as any).eval).toBeUndefined();
  });
  it("absent quota defaults to null (= unset), absent flag to false", () => {
    const caps = rowsToCaps([]);
    expect(caps.calendar.sync).toBe(false);
    expect(caps.calendar.sync_limit).toBe(null);
  });
  it.each(["-1", "Infinity", "abc", "1e9", "3.5"])("rejects malformed quota %s → null", (bad) => {
    const caps = rowsToCaps([{ subsystem: "calendar", capability: "sync_limit", value: bad }]);
    expect(caps.calendar.sync_limit).toBe(null);
  });
});

describe("subsystemForAccessToken (least-disclosure gating)", () => {
  it("no user (client_credentials/M2M) → null", () => {
    expect(subsystemForAccessToken({ user: null, metadata: { subsystem: "calendar" } })).toBe(null);
    expect(subsystemForAccessToken({ metadata: { subsystem: "calendar" } })).toBe(null);
  });
  it("user present, no metadata → null", () => {
    expect(subsystemForAccessToken({ user: { id: "u1" } })).toBe(null);
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: null })).toBe(null);
  });
  it("user present, metadata without subsystem → null", () => {
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: { foo: "bar" } })).toBe(null);
  });
  it("user present, unknown subsystem string (no-blanket guard) → null", () => {
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: { subsystem: "evil" } })).toBe(null);
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: { subsystem: "admin" } })).toBe(null);
  });
  it("user present, subsystem not a string → null", () => {
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: { subsystem: 123 as unknown as string } })).toBe(null);
  });
  it("user present, valid subsystem 'calendar' → 'calendar'", () => {
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: { subsystem: "calendar" } })).toBe("calendar");
  });
  it("user present, valid subsystem 'cqu' → 'cqu'", () => {
    expect(subsystemForAccessToken({ user: { id: "u1" }, metadata: { subsystem: "cqu" } })).toBe("cqu");
  });
});
