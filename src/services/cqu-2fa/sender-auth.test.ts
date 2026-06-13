import { describe, it, expect } from "vitest";
import { envelopeSenderAllowed, forwardSenderAllowed, CQU_SENDER } from "./sender-auth";

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

describe("forwardSenderAllowed", () => {
  // forward 模式：envelope ∈ 用户登记的转发地址（穿过该用户转发器）
  // && header From 地址 === sso@cqu.edu.cn（补回 CQU 来源信号，可伪造）。
  const whitelist = ["fwd@user-mail.example"];

  it("accepts when envelope matches the forward address AND header From is CQU", () => {
    expect(
      forwardSenderAllowed("fwd@user-mail.example", "sso@cqu.edu.cn", whitelist)
    ).toBe(true);
  });

  it("rejects when envelope passes but header From is not CQU (header From mismatch)", () => {
    expect(
      forwardSenderAllowed("fwd@user-mail.example", "evil@attacker.com", whitelist)
    ).toBe(false);
  });

  it("rejects when envelope does not match (without consulting header From)", () => {
    // envelope 不在白名单：即便 header From 是 CQU 也必须拒。
    expect(
      forwardSenderAllowed("someone@else.example", "sso@cqu.edu.cn", whitelist)
    ).toBe(false);
  });

  it("rejects when neither envelope nor header From match", () => {
    expect(
      forwardSenderAllowed("someone@else.example", "evil@attacker.com", whitelist)
    ).toBe(false);
  });

  it("normalizes header From casing (CQU sender casing is not significant)", () => {
    expect(
      forwardSenderAllowed("fwd@user-mail.example", "SSO@CQU.EDU.CN", whitelist)
    ).toBe(true);
  });

  it("trims surrounding whitespace on header From before comparing", () => {
    expect(
      forwardSenderAllowed("fwd@user-mail.example", "  sso@cqu.edu.cn  ", whitelist)
    ).toBe(true);
  });

  it("normalizes envelope casing/whitespace via envelopeSenderAllowed", () => {
    expect(
      forwardSenderAllowed("  FWD@USER-MAIL.EXAMPLE  ", "sso@cqu.edu.cn", whitelist)
    ).toBe(true);
  });

  it("rejects an empty header From even when envelope passes", () => {
    expect(
      forwardSenderAllowed("fwd@user-mail.example", "", whitelist)
    ).toBe(false);
  });

  it("rejects an empty envelope sender even when header From is CQU", () => {
    expect(forwardSenderAllowed("", "sso@cqu.edu.cn", whitelist)).toBe(false);
  });

  it("rejects an undefined/null header From without throwing", () => {
    expect(
      forwardSenderAllowed(
        "fwd@user-mail.example",
        undefined as unknown as string,
        whitelist
      )
    ).toBe(false);
    expect(
      forwardSenderAllowed(
        "fwd@user-mail.example",
        null as unknown as string,
        whitelist
      )
    ).toBe(false);
  });

  it("rejects against an empty whitelist regardless of header From", () => {
    expect(forwardSenderAllowed("fwd@user-mail.example", "sso@cqu.edu.cn", [])).toBe(
      false
    );
  });
});

describe("forwardSenderAllowed with dual-source whitelist [forwardAddr, CQU_SENDER]", () => {
  // forward 模式双源白名单（POST /address 实际写入的形状）：覆盖两类转发器。
  //   - 真转发（如 Fastmail "Send a copy to"）：保留原始信封 sso@cqu.edu.cn（非 SRS 改写）。
  //   - SRS 改写：信封被改成转发方地址（forwardAddr）。
  // header From 两类下均仍是 sso@cqu.edu.cn。
  const fwd = "fwd@user-mail.example";
  const whitelist = [fwd, CQU_SENDER];

  it("(a) accepts a true-forward: envelope=CQU AND header From=CQU", () => {
    // Fastmail "Send a copy to" 这类真转发：信封仍是 sso@cqu.edu.cn。
    expect(forwardSenderAllowed(CQU_SENDER, CQU_SENDER, whitelist)).toBe(true);
  });

  it("(b) accepts an SRS rewrite: envelope=forwardAddr AND header From=CQU", () => {
    // SRS 改写：信封变成转发方地址，但 header From 仍是 sso@cqu.edu.cn。
    expect(forwardSenderAllowed(fwd, CQU_SENDER, whitelist)).toBe(true);
  });

  it("(c) rejects when envelope is neither forwardAddr nor CQU even if header From=CQU", () => {
    // 信封既非转发方也非 CQU：即便 header From 是 CQU 也必须拒。
    expect(
      forwardSenderAllowed("someone@else.example", CQU_SENDER, whitelist)
    ).toBe(false);
  });
});
