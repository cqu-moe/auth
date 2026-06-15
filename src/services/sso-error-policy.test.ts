import { describe, expect, it } from "vitest";
import { CquSsoError } from "./cqu-sso";
import { isTransientSsoError } from "./sso-error-policy";

describe("isTransientSsoError", () => {
  it("treats network/parse/WAF errors as transient (keep session, no relogin)", () => {
    expect(isTransientSsoError(new CquSsoError("NETWORK_ERROR", "x"))).toBe(true);
    expect(isTransientSsoError(new CquSsoError("PARSE_ERROR", "x"))).toBe(true);
    expect(isTransientSsoError(new CquSsoError("WAF_CHALLENGE", "x"))).toBe(true);
  });

  it("treats real auth rejection as NOT transient (→ trigger relogin)", () => {
    expect(isTransientSsoError(new CquSsoError("TGT_EXPIRED", "x"))).toBe(false);
    expect(isTransientSsoError(new CquSsoError("NO_TICKET", "x"))).toBe(false);
  });

  it("treats unknown (non-CquSsoError) failures as transient (conservative)", () => {
    expect(isTransientSsoError(new Error("boom"))).toBe(true);
    expect(isTransientSsoError("weird")).toBe(true);
  });
});
