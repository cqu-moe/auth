import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CquSsoClient, CquSsoError, isRetryableSsoError } from "./cqu-sso";

const COOKIES = { SOURCEID_TGC: "tgc", SESSION: "sess", rg_objectid: "rg" };
const SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas";
// 0ms 退避: 单测不为退避真等。
const FAST = { baseBackoffMs: 0 };

function redirect302(ticket: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `https://my.cqu.edu.cn/x?ticket=${ticket}&foo=1` },
  });
}

beforeEach(() => {
  // 诊断日志(console.log)在失败路径会刷屏, 单测里静音保持输出干净。
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CquSsoClient.getServiceTicket retry", () => {
  it("retries a network timeout, then returns the ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(redirect302("ST-good-123"));
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await new CquSsoClient().getServiceTicket(COOKIES, SERVICE, FAST);

    expect(ticket).toBe("ST-good-123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 瑞数 WAF challenge (non-302, no cas markers), then returns the ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>botgate debugger</html>", { status: 200 }))
      .mockResolvedValueOnce(redirect302("ST-after-waf"));
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await new CquSsoClient().getServiceTicket(COOKIES, SERVICE, FAST);

    expect(ticket).toBe("ST-after-waf");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a real CAS expiry (cas-login page) — fails fast as TGT_EXPIRED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('<input id="login-croypto" value="x">', { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CquSsoClient().getServiceTicket(COOKIES, SERVICE, FAST)
    ).rejects.toMatchObject({ code: "TGT_EXPIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts all attempts on persistent network error, then throws NETWORK_ERROR", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CquSsoClient().getServiceTicket(COOKIES, SERVICE, { baseBackoffMs: 0, maxAttempts: 3 })
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("exhausts all attempts on persistent WAF challenge, then throws WAF_CHALLENGE", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>botgate</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CquSsoClient().getServiceTicket(COOKIES, SERVICE, { baseBackoffMs: 0, maxAttempts: 3 })
    ).rejects.toMatchObject({ code: "WAF_CHALLENGE" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("isRetryableSsoError", () => {
  it("treats NETWORK_ERROR and WAF_CHALLENGE as retryable", () => {
    expect(isRetryableSsoError(new CquSsoError("NETWORK_ERROR", "x"))).toBe(true);
    expect(isRetryableSsoError(new CquSsoError("WAF_CHALLENGE", "x"))).toBe(true);
  });

  it("treats TGT_EXPIRED and NO_TICKET as non-retryable", () => {
    expect(isRetryableSsoError(new CquSsoError("TGT_EXPIRED", "x"))).toBe(false);
    expect(isRetryableSsoError(new CquSsoError("NO_TICKET", "x"))).toBe(false);
  });
});
