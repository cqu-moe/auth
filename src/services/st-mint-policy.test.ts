import { describe, it, expect } from "vitest";
import {
  pruneStMintLog,
  stMintThrottled,
  distinctBroadHosts,
  type StMintRecord,
  ST_MINT_RATE_WINDOW_MS,
  MAX_ST_MINTS_PER_USER,
  MAX_ST_MINTS_PER_CLIENT,
  DISTINCT_HOST_ALERT_THRESHOLD,
} from "./st-mint-policy";

function rec(
  partial: Partial<StMintRecord> & { ts: number }
): StMintRecord {
  return {
    clientId: null,
    host: "my.cqu.edu.cn",
    broad: false,
    ...partial,
  };
}

describe("pruneStMintLog", () => {
  const now = 1_000_000;
  const windowMs = ST_MINT_RATE_WINDOW_MS;

  it("空 log -> 空", () => {
    expect(pruneStMintLog([], now, windowMs)).toEqual([]);
  });
  it("窗口内保留、窗口外丢弃", () => {
    const old = rec({ ts: now - windowMs - 1 }); // 滑出窗口
    const recent = rec({ ts: now - 1000 }); // 窗口内
    expect(pruneStMintLog([old, recent], now, windowMs)).toEqual([recent]);
  });
  it("下界含等于(now - windowMs)", () => {
    const onLowerBound = rec({ ts: now - windowMs });
    expect(pruneStMintLog([onLowerBound], now, windowMs)).toEqual([
      onLowerBound,
    ]);
  });
  it("上界含等于(now), 丢弃未来时刻(时钟漂移)", () => {
    const onNow = rec({ ts: now });
    const future = rec({ ts: now + 1 });
    expect(pruneStMintLog([onNow, future], now, windowMs)).toEqual([onNow]);
  });
  it("不改入参, 返回新数组", () => {
    const input = [rec({ ts: now - 1 }), rec({ ts: now - 2 })];
    const out = pruneStMintLog(input, now, windowMs);
    expect(out).not.toBe(input);
    expect(input.length).toBe(2);
  });
});

describe("stMintThrottled", () => {
  const maxUser = MAX_ST_MINTS_PER_USER; // 60
  const maxClient = MAX_ST_MINTS_PER_CLIENT; // 30

  it("空 log -> 不限流", () => {
    expect(stMintThrottled([], "c1", maxUser, maxClient)).toBe(false);
  });
  it("达到 per-user 上限 -> 限流(即便分散在多个 client)", () => {
    // maxUser 条, 分摊到两个 client(各 < maxClient), 仍触 per-user 闸。
    const pruned = Array.from({ length: maxUser }, (_, i) =>
      rec({ ts: 1000 + i, clientId: i % 2 === 0 ? "a" : "b" })
    );
    expect(stMintThrottled(pruned, "c-new", maxUser, maxClient)).toBe(true);
  });
  it("per-client 上限到了但总数未到 per-user -> 该 client 限流", () => {
    const pruned = Array.from({ length: maxClient }, (_, i) =>
      rec({ ts: 1000 + i, clientId: "busy" })
    );
    // 总数 maxClient(<maxUser), 但 busy 这个 client 已达上限。
    expect(stMintThrottled(pruned, "busy", maxUser, maxClient)).toBe(true);
  });
  it("一个 client 占满, 另一个 client 仍可取票", () => {
    const pruned = Array.from({ length: maxClient }, (_, i) =>
      rec({ ts: 1000 + i, clientId: "busy" })
    );
    expect(stMintThrottled(pruned, "fresh", maxUser, maxClient)).toBe(false);
  });
  it("null clientId 的计数互不串台(null 只跟 null 比)", () => {
    // maxClient 条 null-client 记录 -> 再来一次 null 应被该 client 闸限流。
    const pruned = Array.from({ length: maxClient }, (_, i) =>
      rec({ ts: 1000 + i, clientId: null })
    );
    expect(stMintThrottled(pruned, null, maxUser, maxClient)).toBe(true);
    // 但具名 client 不受 null 占用影响。
    expect(stMintThrottled(pruned, "named", maxUser, maxClient)).toBe(false);
  });
  it("just below per-user 且 just below per-client -> 不限流", () => {
    const pruned = Array.from({ length: maxClient - 1 }, (_, i) =>
      rec({ ts: 1000 + i, clientId: "x" })
    );
    expect(stMintThrottled(pruned, "x", maxUser, maxClient)).toBe(false);
  });
});

describe("distinctBroadHosts", () => {
  it("空 log + null candidate -> 0", () => {
    expect(distinctBroadHosts([], null)).toBe(0);
  });
  it("只数 broad 记录(symbolic 不计)", () => {
    const pruned = [
      rec({ ts: 1, host: "a.cqu.edu.cn", broad: true }),
      rec({ ts: 2, host: "b.cqu.edu.cn", broad: false }), // symbolic, 不计
      rec({ ts: 3, host: "c.cqu.edu.cn", broad: true }),
    ];
    // a + c = 2 distinct broad hosts; candidate null 不加。
    expect(distinctBroadHosts(pruned, null)).toBe(2);
  });
  it("candidate host 计入(即便 log 里没有)", () => {
    const pruned = [
      rec({ ts: 1, host: "a.cqu.edu.cn", broad: true }),
      rec({ ts: 2, host: "b.cqu.edu.cn", broad: true }),
    ];
    expect(distinctBroadHosts(pruned, "c.cqu.edu.cn")).toBe(3);
  });
  it("candidate host 已在 log 中 -> 不重复计数", () => {
    const pruned = [
      rec({ ts: 1, host: "a.cqu.edu.cn", broad: true }),
      rec({ ts: 2, host: "b.cqu.edu.cn", broad: true }),
    ];
    expect(distinctBroadHosts(pruned, "a.cqu.edu.cn")).toBe(2);
  });
  it("去重: 同一 broad host 多条只算一个", () => {
    const pruned = [
      rec({ ts: 1, host: "a.cqu.edu.cn", broad: true }),
      rec({ ts: 2, host: "a.cqu.edu.cn", broad: true }),
      rec({ ts: 3, host: "a.cqu.edu.cn", broad: true }),
    ];
    expect(distinctBroadHosts(pruned, null)).toBe(1);
  });
  it("candidate 与 broad 记录组合越过告警阈值", () => {
    const hosts = ["h1", "h2", "h3", "h4", "h5"].map((h, i) =>
      rec({ ts: i + 1, host: `${h}.cqu.edu.cn`, broad: true })
    );
    // 5 个已有 + 1 candidate = 6 > DISTINCT_HOST_ALERT_THRESHOLD(5)
    expect(distinctBroadHosts(hosts, "h6.cqu.edu.cn")).toBeGreaterThan(
      DISTINCT_HOST_ALERT_THRESHOLD
    );
  });
});
