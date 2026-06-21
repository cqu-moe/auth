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

describe("hasValidTgt", () => {
  it("含非空 SOURCEID_TGC -> true", () => {
    expect(
      hasValidTgt(state([{ name: "SOURCEID_TGC", value: "tgc" }]))
    ).toBe(true);
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
      hasValidTgt(state([{ name: "SOURCEID_TGC", value: "" }]))
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
  it("502 -> transient", () => {
    const c = classifyNodeTicketResponse(502, { ok: false, error: "NO_TICKET" });
    expect(c.kind).toBe("transient");
    expect(c.detail).toContain("502");
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
