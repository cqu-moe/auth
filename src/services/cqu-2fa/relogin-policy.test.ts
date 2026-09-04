import { describe, it, expect } from "vitest";
import {
  shouldProactiveRelogin,
  pruneAttempts,
  shouldThrottleRelogin,
  RELOGIN_RATE_WINDOW_MS,
  MAX_RELOGINS_PER_WINDOW,
  classifyLoginFailure,
  shouldRequireReauth,
  MAX_CREDENTIAL_FAILS,
  nextKeepaliveDelayMs,
} from "./relogin-policy";

describe("shouldProactiveRelogin", () => {
  const now = 100_000_000;
  const threshold = 7 * 60 * 60 * 1000; // 7h

  it("active + 老 loginAt(超阈值) -> true", () => {
    expect(
      shouldProactiveRelogin("active", now - threshold - 1, now, threshold)
    ).toBe(true);
  });
  it("非 active -> false", () => {
    expect(
      shouldProactiveRelogin("relogging", now - threshold - 1, now, threshold)
    ).toBe(false);
    expect(
      shouldProactiveRelogin("expired", now - threshold - 1, now, threshold)
    ).toBe(false);
    expect(
      shouldProactiveRelogin("binding", now - threshold - 1, now, threshold)
    ).toBe(false);
  });
  it("loginAt = 0 -> false", () => {
    expect(shouldProactiveRelogin("active", 0, now, threshold)).toBe(false);
  });
  it("未到阈值 -> false", () => {
    expect(
      shouldProactiveRelogin("active", now - threshold + 1, now, threshold)
    ).toBe(false);
  });
  it("边界 now - loginAt === thresholdMs -> true", () => {
    expect(
      shouldProactiveRelogin("active", now - threshold, now, threshold)
    ).toBe(true);
  });
});

describe("pruneAttempts", () => {
  const now = 1_000_000;
  const windowMs = 60_000;

  it("空数组 -> 空数组", () => {
    expect(pruneAttempts([], now, windowMs)).toEqual([]);
  });
  it("窗口内保留、窗口外丢弃", () => {
    const old = now - windowMs - 1; // 滑出窗口
    const recent = now - 1000; // 窗口内
    expect(pruneAttempts([old, recent], now, windowMs)).toEqual([recent]);
  });
  it("下界含等于(now - windowMs)", () => {
    const onLowerBound = now - windowMs;
    expect(pruneAttempts([onLowerBound], now, windowMs)).toEqual([
      onLowerBound,
    ]);
  });
  it("上界含等于(now), 丢弃未来时刻(时钟漂移)", () => {
    const future = now + 1;
    expect(pruneAttempts([now, future], now, windowMs)).toEqual([now]);
  });
  it("不改入参, 返回新数组", () => {
    const input = [now - 1, now - 2];
    const out = pruneAttempts(input, now, windowMs);
    expect(out).not.toBe(input);
    expect(input).toEqual([now - 1, now - 2]);
  });
});

describe("shouldThrottleRelogin", () => {
  const now = 1_000_000;
  const windowMs = RELOGIN_RATE_WINDOW_MS;
  const max = MAX_RELOGINS_PER_WINDOW; // 6

  it("空数组 -> false", () => {
    expect(shouldThrottleRelogin([], now, windowMs, max)).toBe(false);
  });
  it("少于 max -> false", () => {
    const attempts = Array.from({ length: max - 1 }, (_, i) => now - i * 1000);
    expect(shouldThrottleRelogin(attempts, now, windowMs, max)).toBe(false);
  });
  it("恰好达到 max -> true", () => {
    const attempts = Array.from({ length: max }, (_, i) => now - i * 1000);
    expect(shouldThrottleRelogin(attempts, now, windowMs, max)).toBe(true);
  });
  it("超过 max -> true", () => {
    const attempts = Array.from({ length: max + 2 }, (_, i) => now - i * 1000);
    expect(shouldThrottleRelogin(attempts, now, windowMs, max)).toBe(true);
  });
  it("窗口外的旧时刻不计数(达到 max 但多数已过期 -> false)", () => {
    // 1 个窗口内 + (max+5) 个窗口外: 裁剪后只剩 1, 不限流。
    const insideWindow = [now - 1000];
    const expired = Array.from(
      { length: max + 5 },
      (_, i) => now - windowMs - 1 - i * 1000
    );
    expect(
      shouldThrottleRelogin([...insideWindow, ...expired], now, windowMs, max)
    ).toBe(false);
  });
});

describe("classifyLoginFailure", () => {
  it("CQU 明确凭据错误码 -> credential", () => {
    expect(
      classifyLoginFailure(
        "first-factor failed: credential_rejected:用户名或密码错误"
      )
    ).toBe("credential");
    expect(classifyLoginFailure("first-factor failed: fail:用户名或密码错误")).toBe(
      "credential"
    );
    expect(classifyLoginFailure("fail:账号已锁定")).toBe("credential");
  });
  it("歧义『回到登录页(密码错误/瑞数软重挑战)』-> transient(保守, 不误杀)", () => {
    // 含『密码错误』但被『回到登录页』优先判为歧义/瑞数 → 不当凭据死。
    expect(
      classifyLoginFailure("first-factor failed: fail:回到登录页(密码错误/瑞数软重挑战)")
    ).toBe("transient");
  });
  it("瑞数/未知/未渲染/超时 -> transient", () => {
    expect(classifyLoginFailure("fail:未判定 url=https://sso.cqu.edu.cn/login")).toBe(
      "transient"
    );
    expect(classifyLoginFailure("fail:登录页未渲染(疑似被瑞数挑战/限流)")).toBe(
      "transient"
    );
    expect(classifyLoginFailure("NETWORK_ERROR: CQU SSO unreachable: timeout")).toBe(
      "transient"
    );
  });
  it("空/未知默认 transient(安全)", () => {
    expect(classifyLoginFailure(undefined)).toBe("transient");
    expect(classifyLoginFailure("")).toBe("transient");
    expect(classifyLoginFailure("some unrecognized error")).toBe("transient");
  });
});

describe("shouldRequireReauth", () => {
  it("连续凭据失败达 MAX_CREDENTIAL_FAILS -> true", () => {
    expect(shouldRequireReauth(MAX_CREDENTIAL_FAILS)).toBe(true);
    expect(shouldRequireReauth(MAX_CREDENTIAL_FAILS + 1)).toBe(true);
  });
  it("未达阈值 -> false", () => {
    expect(shouldRequireReauth(0)).toBe(false);
    expect(shouldRequireReauth(MAX_CREDENTIAL_FAILS - 1)).toBe(false);
  });
});

describe("nextKeepaliveDelayMs", () => {
  const opts = {
    fastRetries: 5,
    fastMs: 60_000, // 60s
    baseMs: 15 * 60_000, // 15min
    capMs: 6 * 60 * 60_000, // 6h
  };
  it("快重试窗口内(<= fastRetries) -> fastMs", () => {
    expect(nextKeepaliveDelayMs(1, opts)).toBe(opts.fastMs);
    expect(nextKeepaliveDelayMs(5, opts)).toBe(opts.fastMs);
  });
  it("超过快重试 -> 从 baseMs 指数退避", () => {
    expect(nextKeepaliveDelayMs(6, opts)).toBe(opts.baseMs); // 15min
    expect(nextKeepaliveDelayMs(7, opts)).toBe(opts.baseMs * 2); // 30min
    expect(nextKeepaliveDelayMs(8, opts)).toBe(opts.baseMs * 4); // 1h
  });
  it("封顶 capMs", () => {
    expect(nextKeepaliveDelayMs(99, opts)).toBe(opts.capMs);
  });
});
