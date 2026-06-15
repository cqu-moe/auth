import { describe, it, expect } from "vitest";
import { cquErrorHttpStatus } from "./cqu-error-status";

describe("cquErrorHttpStatus", () => {
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

  it("maps RATE_LIMITED → 429", () => {
    expect(cquErrorHttpStatus("RATE_LIMITED")).toBe(429);
  });

  it("maps INTERNAL_ERROR → 500", () => {
    expect(cquErrorHttpStatus("INTERNAL_ERROR")).toBe(500);
  });

  it("maps TGT_EXPIRED → 500 (non-policy server-side error)", () => {
    expect(cquErrorHttpStatus("TGT_EXPIRED")).toBe(500);
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
});
