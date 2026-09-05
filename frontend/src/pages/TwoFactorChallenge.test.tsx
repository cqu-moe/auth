import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import TwoFactorChallenge from "./TwoFactorChallenge";

describe("two-factor login challenge", () => {
  it("renders the supported challenge controls without passkey", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/two-factor"] },
        createElement(TwoFactorChallenge)
      )
    );

    expect(html).toContain("二次验证");
    expect(html).toContain("身份验证器");
    expect(html).toContain("邮箱验证码");
    expect(html).toContain("备用恢复码");
    expect(html).toContain("在这台设备上保持信任 30 天");
    expect(html).not.toContain("Passkey");
  });
});
