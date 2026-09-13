import { describe, it, expect } from "vitest";
import { cquErrorHttpStatus } from "./cqu-error-status";

describe("cquErrorHttpStatus", () => {
  it.each([
    ["WAF_BOOTSTRAP_TIMEOUT", 503], ["APP_READY_TIMEOUT", 503],
    ["TABLE_CAPTURE_TIMEOUT", 503], ["TABLE_REQUEST_HUNG", 504],
    ["TABLE_BODY_TIMEOUT", 504], ["TABLE_API_REJECTED", 502],
    ["WAF_CHALLENGE", 503], ["SCHEDULE_NOT_PUBLISHED", 409], ["HARVEST_TRANSIENT", 503],
  ])("maps %s to %s", (code, status) => {
    expect(cquErrorHttpStatus(code as string)).toBe(status);
  });
  it("maps INVALID_SERVICE_URL → 400", () => {
    expect(cquErrorHttpStatus("INVALID_SERVICE_URL")).toBe(400);
  });

  it("maps UNKNOWN_SERVICE → 400", () => {
    expect(cquErrorHttpStatus("UNKNOWN_SERVICE")).toBe(400);
  });

  it("maps QUICKLOGIN_NOT_ENABLED → 403", () => {
    expect(cquErrorHttpStatus("QUICKLOGIN_NOT_ENABLED")).toBe(403);
  });

  it("maps SESSION_INACTIVE → 409", () => {
    expect(cquErrorHttpStatus("SESSION_INACTIVE")).toBe(409);
  });

  it("maps NEEDS_REAUTH → 409", () => {
    expect(cquErrorHttpStatus("NEEDS_REAUTH")).toBe(409);
  });

  it("maps RATE_LIMITED → 429", () => {
    expect(cquErrorHttpStatus("RATE_LIMITED")).toBe(429);
  });

  it("maps INTERNAL_ERROR → 500", () => {
    expect(cquErrorHttpStatus("INTERNAL_ERROR")).toBe(500);
  });

  // H4: TGT 过期是「可行动态」的会话失效(交重登/会自愈), 同 SESSION_INACTIVE/NEEDS_REAUTH
  // 一类回 409, 而非 500(伪装成服务器崩溃, 调用方无法区分该重试/会自愈)。
  it("maps TGT_EXPIRED → 409 (actionable session expiry, like NEEDS_REAUTH)", () => {
    expect(cquErrorHttpStatus("TGT_EXPIRED")).toBe(409);
  });

  it("maps NO_TICKET → 500", () => {
    expect(cquErrorHttpStatus("NO_TICKET")).toBe(500);
  });

  it("maps NETWORK_ERROR → 500", () => {
    expect(cquErrorHttpStatus("NETWORK_ERROR")).toBe(500);
  });

  it("maps an unknown code → 500", () => {
    expect(cquErrorHttpStatus("SOME_UNKNOWN_CODE")).toBe(500);
  });

  it("maps browser capacity/replacement/deadline codes → 503", () => {
    expect(cquErrorHttpStatus("BROWSER_BUSY")).toBe(503);
    expect(cquErrorHttpStatus("BROWSER_INSTANCE_REPLACED")).toBe(503);
    expect(cquErrorHttpStatus("BROWSER_DEADLINE")).toBe(503);
  });

  it("maps INVALID_BROWSER_DEADLINE → 400", () => {
    expect(cquErrorHttpStatus("INVALID_BROWSER_DEADLINE")).toBe(400);
  });
});
