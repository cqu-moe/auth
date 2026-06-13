import { describe, it, expect } from "vitest";
import { shouldStartLogin, LOGIN_LOCK_TTL_MS } from "./single-flight";

describe("shouldStartLogin", () => {
  const now = 1_000_000;
  it("starts when no lock", () => {
    expect(shouldStartLogin(null, now)).toBe(true);
  });
  it("blocks when fresh lock in flight", () => {
    expect(shouldStartLogin({ token: "x", startedAt: now - 1000 }, now)).toBe(false);
  });
  it("starts when stale lock (> TTL, crashed login)", () => {
    expect(shouldStartLogin({ token: "x", startedAt: now - LOGIN_LOCK_TTL_MS - 1 }, now)).toBe(true);
  });
});
