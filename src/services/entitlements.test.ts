import { describe, it, expect } from "vitest";
import {
  rowsToCaps,
  subsystemForAccessToken,
  validateEntitlementItems,
  presetToItems,
} from "./entitlements";

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

describe("validateEntitlementItems (admin write validation)", () => {
  it("accepts valid mixed flag + quota items → null", () => {
    const items = [
      { subsystem: "calendar", capability: "sync", value: "1" },
      { subsystem: "calendar", capability: "sync_limit", value: "200" },
      { subsystem: "eval", capability: "submit", value: "1" },
    ];
    expect(validateEntitlementItems(items)).toBe(null);
  });
  it("rejects unknown subsystem → non-null error", () => {
    const err = validateEntitlementItems([
      { subsystem: "billing", capability: "sync", value: "1" },
    ]);
    expect(err).not.toBe(null);
    expect(typeof err).toBe("string");
  });
  it("rejects unknown capability → non-null error", () => {
    const err = validateEntitlementItems([
      { subsystem: "calendar", capability: "nope", value: "1" },
    ]);
    expect(err).not.toBe(null);
  });
  it.each(["2", "0", "true", ""])("rejects flag with bad value %s → non-null error", (bad) => {
    const err = validateEntitlementItems([
      { subsystem: "calendar", capability: "sync", value: bad },
    ]);
    expect(err).not.toBe(null);
  });
  it.each(["-1", "abc", "1.5", "Infinity"])("rejects quota with bad value %s → non-null error", (bad) => {
    const err = validateEntitlementItems([
      { subsystem: "calendar", capability: "sync_limit", value: bad },
    ]);
    expect(err).not.toBe(null);
  });
  it("accepts quota with '' (unlimited) → null", () => {
    expect(
      validateEntitlementItems([
        { subsystem: "calendar", capability: "sync_limit", value: "" },
      ])
    ).toBe(null);
  });
  it("accepts plain non-negative integer quota → null", () => {
    expect(
      validateEntitlementItems([
        { subsystem: "calendar", capability: "sync_limit", value: "0" },
      ])
    ).toBe(null);
  });
  it("rejects non-array input → non-null error", () => {
    expect(validateEntitlementItems("nope" as unknown as [])).not.toBe(null);
    expect(validateEntitlementItems(null as unknown as [])).not.toBe(null);
    expect(validateEntitlementItems({} as unknown as [])).not.toBe(null);
  });
  it("rejects duplicate (subsystem, capability) pairs → non-null error", () => {
    // Same composite PK twice: delete-then-insert would wipe the row then fail
    // the insert on the PK, silently emptying the user's entitlements. Reject early.
    const err = validateEntitlementItems([
      { subsystem: "calendar", capability: "sync", value: "1" },
      { subsystem: "calendar", capability: "sync", value: "1" },
    ]);
    expect(err).not.toBe(null);
    expect(typeof err).toBe("string");
  });
  it("allows same capability name across different subsystems → null", () => {
    // (eval, submit) and (calendar, sync) differ by subsystem; not a duplicate.
    expect(
      validateEntitlementItems([
        { subsystem: "calendar", capability: "sync", value: "1" },
        { subsystem: "eval", capability: "submit", value: "1" },
      ])
    ).toBe(null);
  });
});

describe("presetToItems (admin one-click apply)", () => {
  it("flattens 学生 preset incl. flag + quota items", () => {
    const items = presetToItems("学生");
    expect(items).not.toBe(null);
    expect(items).toContainEqual({ subsystem: "calendar", capability: "sync", value: "1" });
    expect(items).toContainEqual({ subsystem: "calendar", capability: "sync_limit", value: "50" });
    expect(items).toContainEqual({ subsystem: "eval", capability: "submit", value: "1" });
  });
  it("translates null quota to '' and includes share flag for 助教", () => {
    const items = presetToItems("助教");
    expect(items).not.toBe(null);
    expect(items).toContainEqual({ subsystem: "calendar", capability: "sync_limit", value: "" });
    expect(items).toContainEqual({ subsystem: "calendar", capability: "share", value: "1" });
  });
  it("returns null for an unknown preset name", () => {
    expect(presetToItems("unknown")).toBe(null);
  });
});
