import { describe, it, expect } from "vitest";
import { CquSsoError, type CquStorageState } from "./cqu-sso";
import {
  tgtFromState,
  hasValidTgt,
  classifyNodeTicketResponse,
  ticketFromClassification,
  sanitizeNodeDetail,
  NODE_DEADLINE_MS,
  serializedStateBytes,
  stateExceedsHardLimit,
  STATE_HARD_LIMIT_BYTES,
  STORAGE_STATE_WARN_BYTES,
  shouldAbandonKeepaliveWriteback,
  buildStMintAudit,
} from "./cqu-node-protocol";

function state(
  cookies: Array<{ name: string; value: string }>
): CquStorageState {
  return {
    cookies: cookies.map((c) => ({
      ...c,
      domain: "sso.cqu.edu.cn",
      path: "/",
    })),
    origins: [],
  };
}

describe("tgtFromState", () => {
  it("存在 SOURCEID_TGC -> 返回其值", () => {
    expect(
      tgtFromState(state([{ name: "SOURCEID_TGC", value: "tgc-123" }]))
    ).toBe("tgc-123");
  });
  it("缺失 SOURCEID_TGC -> 空串(不抛)", () => {
    expect(tgtFromState(state([{ name: "SESSION", value: "s" }]))).toBe("");
  });
  it("state=null -> 空串(不抛)", () => {
    expect(tgtFromState(null)).toBe("");
  });
});

// M5: hasValidTgt 升级为要求 CasCookies 三件套(SOURCEID_TGC + SESSION + rg_objectid)
// 都存在且非空(对齐 cqu-sso.ts 的 3-cookie 契约), 不再「仅 SOURCEID_TGC 即有效」。
const TRIPLE: Array<{ name: string; value: string }> = [
  { name: "SOURCEID_TGC", value: "tgc" },
  { name: "SESSION", value: "sess" },
  { name: "rg_objectid", value: "rg" },
];
describe("hasValidTgt", () => {
  it("三件套齐(SOURCEID_TGC+SESSION+rg_objectid)非空 -> true", () => {
    expect(hasValidTgt(state(TRIPLE))).toBe(true);
  });
  it("仅 SOURCEID_TGC、缺 SESSION/rg_objectid -> false", () => {
    expect(
      hasValidTgt(state([{ name: "SOURCEID_TGC", value: "tgc" }]))
    ).toBe(false);
  });
  it("缺 SESSION -> false", () => {
    expect(
      hasValidTgt(
        state([
          { name: "SOURCEID_TGC", value: "tgc" },
          { name: "rg_objectid", value: "rg" },
        ])
      )
    ).toBe(false);
  });
  it("缺 rg_objectid -> false", () => {
    expect(
      hasValidTgt(
        state([
          { name: "SOURCEID_TGC", value: "tgc" },
          { name: "SESSION", value: "sess" },
        ])
      )
    ).toBe(false);
  });
  it("cookies 空数组 -> false", () => {
    expect(hasValidTgt(state([]))).toBe(false);
  });
  it("有 cookie 但无 SOURCEID_TGC -> false", () => {
    expect(
      hasValidTgt(state([{ name: "SESSION", value: "s" }]))
    ).toBe(false);
  });
  it("SOURCEID_TGC 值为空串 -> false", () => {
    expect(
      hasValidTgt(
        state([
          { name: "SOURCEID_TGC", value: "" },
          { name: "SESSION", value: "sess" },
          { name: "rg_objectid", value: "rg" },
        ])
      )
    ).toBe(false);
  });
  it("SESSION 值为空串 -> false", () => {
    expect(
      hasValidTgt(
        state([
          { name: "SOURCEID_TGC", value: "tgc" },
          { name: "SESSION", value: "" },
          { name: "rg_objectid", value: "rg" },
        ])
      )
    ).toBe(false);
  });
  it("rg_objectid 值为空串 -> false", () => {
    expect(
      hasValidTgt(
        state([
          { name: "SOURCEID_TGC", value: "tgc" },
          { name: "SESSION", value: "sess" },
          { name: "rg_objectid", value: "" },
        ])
      )
    ).toBe(false);
  });
  it("state=null -> false", () => {
    expect(hasValidTgt(null)).toBe(false);
  });
});

describe("classifyNodeTicketResponse", () => {
  it("409 -> expired(先于 body 判)", () => {
    expect(classifyNodeTicketResponse(409, { ok: false }).kind).toBe(
      "expired"
    );
    // 即便 body=null 也按 409 判 expired。
    expect(classifyNodeTicketResponse(409, null).kind).toBe("expired");
  });
  it("502 -> transient(detail 含 status)", () => {
    const c = classifyNodeTicketResponse(502, { ok: false, error: "NO_TICKET" });
    expect(c.kind).toBe("transient");
    expect(c.detail).toContain("502");
  });
  // H5: 节点回的 raw body.error 绝不原样进 detail(detail 会经 CquSsoError.message
  // 透传 route → 客户端/日志)。构造含敏感 cookie 串的 error, 断言 detail 不含该串。
  it("transient detail 不回显节点 raw body.error(脱敏)", () => {
    const secret = "SOURCEID_TGC=SECRETVALUE; SESSION=leaked";
    const c = classifyNodeTicketResponse(502, { ok: false, error: secret });
    expect(c.kind).toBe("transient");
    expect(c.detail).not.toContain("SECRETVALUE");
    expect(c.detail).not.toContain("SOURCEID_TGC");
    expect(c.detail).not.toContain(secret);
    // 仍保留可诊断的 status 锚点。
    expect(c.detail).toContain("502");
  });
  it("expired(409) detail 不含任何节点派生字符串", () => {
    // 409 分支不读 body, 但仍断言 detail 是稳定常量、不含 body.error。
    const secret = "SOURCEID_TGC=SECRETVALUE";
    const c = classifyNodeTicketResponse(409, { ok: false, error: secret });
    expect(c.kind).toBe("expired");
    expect(c.detail).not.toContain("SECRETVALUE");
    expect(c.detail).not.toContain("SOURCEID_TGC");
  });
  it("200 缺 ticket -> transient", () => {
    expect(classifyNodeTicketResponse(200, { ok: true }).kind).toBe(
      "transient"
    );
  });
  it("200 ok 但 ok=false -> transient", () => {
    expect(
      classifyNodeTicketResponse(200, { ok: false, ticket: "ST-x" }).kind
    ).toBe("transient");
  });
  it("非 JSON(body=null, 非 409) -> transient", () => {
    const c = classifyNodeTicketResponse(200, null);
    expect(c.kind).toBe("transient");
    expect(c.detail).toContain("non-JSON");
  });
  it("200 ok+ticket -> ok 且带 ticket", () => {
    const c = classifyNodeTicketResponse(200, { ok: true, ticket: "ST-good" });
    expect(c.kind).toBe("ok");
    expect(c.ticket).toBe("ST-good");
  });
});

describe("ticketFromClassification", () => {
  it("ok -> 返回 ticket", () => {
    expect(ticketFromClassification({ kind: "ok", ticket: "ST-y" })).toBe(
      "ST-y"
    );
  });
  it("expired -> 抛 TGT_EXPIRED", () => {
    expect(() => ticketFromClassification({ kind: "expired" })).toThrow(
      CquSsoError
    );
    try {
      ticketFromClassification({ kind: "expired" });
    } catch (e) {
      expect((e as CquSsoError).code).toBe("TGT_EXPIRED");
    }
  });
  it("transient -> 抛 WAF_CHALLENGE", () => {
    try {
      ticketFromClassification({ kind: "transient", detail: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CquSsoError).code).toBe("WAF_CHALLENGE");
    }
  });
  it("ok 但 ticket 缺失(防御) -> 抛 WAF_CHALLENGE", () => {
    try {
      ticketFromClassification({ kind: "ok" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CquSsoError).code).toBe("WAF_CHALLENGE");
    }
  });
});

describe("sanitizeNodeDetail", () => {
  it("非字符串 -> (none)", () => {
    expect(sanitizeNodeDetail(undefined)).toBe("(none)");
    expect(sanitizeNodeDetail(null)).toBe("(none)");
    expect(sanitizeNodeDetail(42)).toBe("(none)");
  });
  it("空串 -> (none)", () => {
    expect(sanitizeNodeDetail("")).toBe("(none)");
  });
  it("多行 -> 只取首行", () => {
    expect(sanitizeNodeDetail("TimeoutException: foo\nsecret-state-blob")).toBe(
      "TimeoutException: foo"
    );
  });
  it("压平内部空白", () => {
    expect(sanitizeNodeDetail("a    b\tc")).toBe("a b c");
  });
  it("超长截断并加省略号", () => {
    const long = "x".repeat(500);
    const out = sanitizeNodeDetail(long);
    expect(out.length).toBeLessThanOrEqual(121); // 120 + …
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("NODE_DEADLINE_MS", () => {
  it("略大于节点最坏 ~80s", () => {
    expect(NODE_DEADLINE_MS).toBeGreaterThan(80_000);
  });
});

// H2: state 落盘体量判定下沉为纯函数, DO put 前据此「告警阈值 / 硬上限」分离判定。
describe("serializedStateBytes", () => {
  it("返回 JSON.stringify 后的 UTF-8 字节数", () => {
    const obj = { a: "hello" };
    expect(serializedStateBytes(obj)).toBe(
      new TextEncoder().encode(JSON.stringify(obj)).length
    );
  });
  it("多字节字符按 UTF-8 计字节(非字符数)", () => {
    // "中" 3 字节; JSON.stringify 加引号 2 字节 → 5。
    expect(serializedStateBytes("中")).toBe(5);
  });
  it("不可序列化(循环引用) -> 返回 Infinity(按超限处理, 不抛)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializedStateBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("STATE_HARD_LIMIT_BYTES / STORAGE_STATE_WARN_BYTES", () => {
  it("告警阈值(100KiB)严格小于硬上限(120KiB)", () => {
    expect(STORAGE_STATE_WARN_BYTES).toBeLessThan(STATE_HARD_LIMIT_BYTES);
  });
  it("硬上限不超过 DO 128KiB 物理上限(留余量)", () => {
    expect(STATE_HARD_LIMIT_BYTES).toBeLessThanOrEqual(128 * 1024);
  });
  // M2: 硬上限对物理 128KiB 留 ≥8KiB 余量, 吸收「JSON.stringify 字节数 vs structured-clone 落盘体量」
  // 度量差额(JSON 字节只是保守近似代理, structured-clone 偏大时 ~1KiB 余量可能不足)。
  it("对 DO 128KiB 物理上限留 ≥8KiB 余量(吸收度量差额)", () => {
    expect(128 * 1024 - STATE_HARD_LIMIT_BYTES).toBeGreaterThanOrEqual(8 * 1024);
  });
});

describe("stateExceedsHardLimit", () => {
  it("低于硬上限 -> false", () => {
    expect(stateExceedsHardLimit(STATE_HARD_LIMIT_BYTES - 1)).toBe(false);
  });
  it("恰等于硬上限 -> false(边界: 仍能 put)", () => {
    expect(stateExceedsHardLimit(STATE_HARD_LIMIT_BYTES)).toBe(false);
  });
  it("超过硬上限 -> true", () => {
    expect(stateExceedsHardLimit(STATE_HARD_LIMIT_BYTES + 1)).toBe(true);
  });
  it("Infinity(不可序列化) -> true", () => {
    expect(stateExceedsHardLimit(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

// M7: keepalive/relogin 写回 active 前的防复活守卫 —— 若期间 status 已被改成
// 撤销/解绑/需重登, 放弃本轮写回(不 setStatus active / 不 putState / 不 setAlarm)。
describe("shouldAbandonKeepaliveWriteback", () => {
  it("revoked -> true(放弃写回, 防复活已撤销会话)", () => {
    expect(shouldAbandonKeepaliveWriteback("revoked")).toBe(true);
  });
  it("unbound -> true(已解绑, 放弃写回)", () => {
    expect(shouldAbandonKeepaliveWriteback("unbound")).toBe(true);
  });
  it("needs_reauth -> true(熔断终态, 放弃写回)", () => {
    expect(shouldAbandonKeepaliveWriteback("needs_reauth")).toBe(true);
  });
  it("active -> false(正常写回)", () => {
    expect(shouldAbandonKeepaliveWriteback("active")).toBe(false);
  });
  it("expired -> false(探针/relogin 路径正常推进)", () => {
    expect(shouldAbandonKeepaliveWriteback("expired")).toBe(false);
  });
  it("relogging -> false(重登在途, 正常推进)", () => {
    expect(shouldAbandonKeepaliveWriteback("relogging")).toBe(false);
  });
  it("binding -> false", () => {
    expect(shouldAbandonKeepaliveWriteback("binding")).toBe(false);
  });
});

// I-1: st_mint 审计行构造下沉为纯函数(三处 emit 共用, 杜绝 schema 漂移)。
// 核心断言: 构造结果与历史手写的 inline 对象**逐字节等价**(JSON.stringify 相等),
// 覆盖取票分支、keepalive 正常分支、keepalive catch 分支(spread + 追加 recorded/err)。
describe("buildStMintAudit", () => {
  it("返回字段集合/顺序固定为 evt,userId,clientId,host,broad,source,ts", () => {
    const out = buildStMintAudit({
      userId: "u1",
      clientId: "c1",
      host: "my.cqu.edu.cn",
      broad: true,
      source: "route",
      ts: 1700000000000,
    });
    expect(out.evt).toBe("st_mint");
    expect(Object.keys(out)).toEqual([
      "evt",
      "userId",
      "clientId",
      "host",
      "broad",
      "source",
      "ts",
    ]);
  });

  it("clientId 可为 null(route 无 azp 自成桶)", () => {
    expect(buildStMintAudit({
      userId: "u1",
      clientId: null,
      host: "h",
      broad: false,
      source: "route",
      ts: 1,
    }).clientId).toBeNull();
  });

  // 字段等价性证明①: 取票分支(getServiceTicket)历史 inline 对象。
  it("逐字节等价: 取票分支历史 inline", () => {
    const userId = "user-abc";
    const clientId: string | null = "plugin-xyz";
    const host = "my.cqu.edu.cn";
    const broad = false;
    const now = 1718000000000;
    const legacy = {
      evt: "st_mint",
      userId,
      clientId,
      host,
      broad,
      source: "route",
      ts: now,
    };
    const built = buildStMintAudit({
      userId,
      clientId,
      host,
      broad,
      source: "route",
      ts: now,
    });
    expect(JSON.stringify(built)).toBe(JSON.stringify(legacy));
  });

  // 字段等价性证明②: keepalive 正常分支历史 inline(clientId=哨兵, source=keepalive, broad=false)。
  it("逐字节等价: keepalive 正常分支历史 inline", () => {
    const userId = "user-abc";
    const host = "my.cqu.edu.cn";
    const now = 1718000000000;
    const legacy = {
      evt: "st_mint",
      userId,
      clientId: "__keepalive__",
      host,
      broad: false,
      source: "keepalive",
      ts: now,
    };
    const built = buildStMintAudit({
      userId,
      clientId: "__keepalive__",
      host,
      broad: false,
      source: "keepalive",
      ts: now,
    });
    expect(JSON.stringify(built)).toBe(JSON.stringify(legacy));
  });

  // 字段等价性证明③: keepalive catch 分支历史 inline(末尾追加 recorded:false + err)。
  // 验证 spread buildStMintAudit 后追加两键 → 追加键序列化在末尾, 与历史逐字节等价。
  it("逐字节等价: keepalive catch 分支历史 inline(spread + recorded/err)", () => {
    const userId = "user-abc";
    const host = "my.cqu.edu.cn";
    const now = 1718000000000;
    const errStr = "storage.put failed";
    const legacy = {
      evt: "st_mint",
      userId,
      clientId: "__keepalive__",
      host,
      broad: false,
      source: "keepalive",
      ts: now,
      recorded: false,
      err: errStr,
    };
    const built = {
      ...buildStMintAudit({
        userId,
        clientId: "__keepalive__",
        host,
        broad: false,
        source: "keepalive",
        ts: now,
      }),
      recorded: false,
      err: errStr,
    };
    expect(JSON.stringify(built)).toBe(JSON.stringify(legacy));
  });
});
