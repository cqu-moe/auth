import { describe, it, expect } from "vitest";
import { CquSsoError, type CquStorageState } from "./cqu-sso";
import {
  tgtFromState,
  hasValidTgt,
  classifyNodeTicketResponse,
  ticketFromClassification,
  sanitizeNodeDetail,
  NODE_DEADLINE_MS,
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
