import { describe, it, expect } from "vitest";
import { parseInboundAuth, senderVerified, trustedCfArc } from "./sender-auth";

const ARC_OK =
  "i=1; mx.cloudflare.net; dkim=none; dmarc=none header.from=cqu.edu.cn; spf=none (mx.cloudflare.net: no SPF for postmaster@cqu.edu.cn) smtp.helo=cqu.edu.cn; spf=pass (mx.cloudflare.net: domain of sso@cqu.edu.cn designates 202.202.0.26 as permitted sender) smtp.mailfrom=sso@cqu.edu.cn; arc=none smtp.remote-ip=202.202.0.26";
const ARC_SPOOF =
  "i=1; mx.cloudflare.net; dkim=none; dmarc=none; spf=fail (mx.cloudflare.net: 1.2.3.4 not permitted) smtp.mailfrom=sso@cqu.edu.cn; arc=none smtp.remote-ip=1.2.3.4";

describe("parseInboundAuth", () => {
  it("takes the mailfrom spf clause (skips the helo spf=none), envelope, remote-ip", () => {
    expect(parseInboundAuth(ARC_OK)).toEqual({
      spf: "pass",
      envelopeFrom: "sso@cqu.edu.cn",
      sourceIp: "202.202.0.26",
    });
  });
  it("reports spf=fail for spoof from non-CQU ip", () => {
    expect(parseInboundAuth(ARC_SPOOF)).toEqual({
      spf: "fail",
      envelopeFrom: "sso@cqu.edu.cn",
      sourceIp: "1.2.3.4",
    });
  });
});

describe("trustedCfArc", () => {
  it("(a) returns CF's own segment for a genuine header; parse yields spf=pass", () => {
    expect(trustedCfArc(ARC_OK)).toBe(ARC_OK);
    expect(parseInboundAuth(trustedCfArc(ARC_OK)!)).toEqual({
      spf: "pass",
      envelopeFrom: "sso@cqu.edu.cn",
      sourceIp: "202.202.0.26",
    });
  });

  it("(b) ignores an attacker-appended forged segment after CF's genuine spf=fail", () => {
    // CF 真段是 spf=fail（来自非 CQU ip），攻击者在尾部追加一条伪造的 spf=pass 段。
    const raw =
      ARC_SPOOF +
      ", i=1; evil.example; spf=pass (mx.cloudflare.net: spoofed) smtp.mailfrom=sso@cqu.edu.cn; arc=none smtp.remote-ip=202.202.0.26";
    const cf = trustedCfArc(raw);
    expect(cf).toBe(ARC_SPOOF); // 只取第一条 CF 实例，尾部伪造段被丢弃
    expect(parseInboundAuth(cf!).spf).toBe("fail");
  });

  it("(c) returns null when header does not start with i=N; mx.cloudflare.net", () => {
    const attacker =
      "i=1; evil.example; spf=pass (spoofed) smtp.mailfrom=sso@cqu.edu.cn; arc=none smtp.remote-ip=202.202.0.26";
    expect(trustedCfArc(attacker)).toBeNull();
  });
});

describe("senderVerified", () => {
  const bind = { kind: "direct", senderWhitelist: ["sso@cqu.edu.cn"] };
  it("accepts spf=pass on envelope + CQU ip", () => {
    expect(senderVerified(parseInboundAuth(ARC_OK), bind)).toBe(true);
  });
  it("rejects spoof (spf=fail, non-CQU ip)", () => {
    expect(senderVerified(parseInboundAuth(ARC_SPOOF), bind)).toBe(false);
  });
});
