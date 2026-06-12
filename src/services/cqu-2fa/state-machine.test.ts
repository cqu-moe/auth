import { describe, it, expect } from "vitest";
import { nextStatus, type CquStatus } from "./state-machine";

describe("nextStatus", () => {
  it("binding -> active on confirm+first login", () => {
    expect(nextStatus("binding", "FIRST_LOGIN_OK")).toBe("active");
  });
  it("active -> relogging on relogin trigger", () => {
    expect(nextStatus("active", "RELOGIN_START")).toBe("relogging");
  });
  it("relogging -> active on success", () => {
    expect(nextStatus("relogging", "RELOGIN_OK")).toBe("active");
  });
  it("relogging -> expired on failure", () => {
    expect(nextStatus("relogging", "RELOGIN_FAIL")).toBe("expired");
  });
  it("expired -> relogging on retry", () => {
    expect(nextStatus("expired", "RELOGIN_START")).toBe("relogging");
  });
  it("any -> revoked on revoke", () => {
    expect(nextStatus("active", "REVOKE")).toBe("revoked");
    expect(nextStatus("expired", "REVOKE")).toBe("revoked");
  });
  it("illegal transition keeps current", () => {
    expect(nextStatus("revoked", "RELOGIN_OK")).toBe("revoked");
  });
});
