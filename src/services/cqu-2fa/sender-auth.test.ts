import { describe, it, expect } from "vitest";
import { envelopeSenderAllowed } from "./sender-auth";

describe("envelopeSenderAllowed", () => {
  const whitelist = ["sso@cqu.edu.cn"];

  it("accepts the whitelisted CQU sender", () => {
    expect(envelopeSenderAllowed("sso@cqu.edu.cn", whitelist)).toBe(true);
  });

  it("matches case-insensitively (envelope MAIL FROM casing is not significant)", () => {
    expect(envelopeSenderAllowed("SSO@CQU.EDU.CN", whitelist)).toBe(true);
    expect(envelopeSenderAllowed("sso@cqu.edu.cn", ["SSO@CQU.EDU.CN"])).toBe(true);
  });

  it("trims surrounding whitespace on both sides before comparing", () => {
    expect(envelopeSenderAllowed("  sso@cqu.edu.cn  ", whitelist)).toBe(true);
    expect(envelopeSenderAllowed("sso@cqu.edu.cn", [" sso@cqu.edu.cn "])).toBe(true);
  });

  it("rejects a sender that is not on the whitelist", () => {
    expect(envelopeSenderAllowed("evil@attacker.com", whitelist)).toBe(false);
  });

  it("rejects an empty envelope sender", () => {
    expect(envelopeSenderAllowed("", whitelist)).toBe(false);
  });

  it("rejects an undefined/null envelope sender without throwing", () => {
    expect(envelopeSenderAllowed(undefined as unknown as string, whitelist)).toBe(false);
    expect(envelopeSenderAllowed(null as unknown as string, whitelist)).toBe(false);
  });

  it("rejects against an empty whitelist", () => {
    expect(envelopeSenderAllowed("sso@cqu.edu.cn", [])).toBe(false);
  });
});
