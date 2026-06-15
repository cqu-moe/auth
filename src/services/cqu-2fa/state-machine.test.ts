import { describe, it, expect } from "vitest";
import { nextStatus, type CquStatus } from "./state-machine";

describe("nextStatus", () => {
  it("binding -> active on confirm+first login", () => {
    expect(nextStatus("binding", "FIRST_LOGIN_OK")).toBe("active");
  });
  it("binding -> unbound on first login failure", () => {
    expect(nextStatus("binding", "FIRST_LOGIN_FAIL")).toBe("unbound");
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
  it("expired -> needs_reauth on REAUTH_REQUIRED(熔断: 凭据真死)", () => {
    expect(nextStatus("expired", "REAUTH_REQUIRED")).toBe("needs_reauth");
  });
  it("needs_reauth -> binding on re-bind(恢复路径)", () => {
    expect(nextStatus("needs_reauth", "START_BIND")).toBe("binding");
  });
  it("needs_reauth -> revoked / unbound", () => {
    expect(nextStatus("needs_reauth", "REVOKE")).toBe("revoked");
    expect(nextStatus("needs_reauth", "UNBIND")).toBe("unbound");
  });
  it("needs_reauth 是终态: 非恢复事件保持不变", () => {
    expect(nextStatus("needs_reauth", "RELOGIN_OK")).toBe("needs_reauth");
    expect(nextStatus("needs_reauth", "RELOGIN_START")).toBe("needs_reauth");
  });
  it("illegal transition keeps current", () => {
    expect(nextStatus("revoked", "RELOGIN_OK")).toBe("revoked");
  });
});
