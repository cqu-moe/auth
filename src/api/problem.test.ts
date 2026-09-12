import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { problem } from "./problem";

describe("Problem Details responses", () => {
  it("returns RFC 9457 fields with the HTTP status mirrored in the body", async () => {
    const app = new Hono();
    app.get("/failure", (c) => problem(c, "INVALID_BODY", "请求体无效", 400));

    const response = await app.request("/failure");

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "请求体无效",
      code: "INVALID_BODY",
    });
  });

  it("keeps core Problem Details fields authoritative when adding extensions", async () => {
    const app = new Hono();
    app.get("/failure", (c) => problem(c, "PREVIEW_CHANGED", "设备状态已变化", 409, {
      status: 200,
      code: "FORGED",
      preview: { token: "latest-token" },
    }));

    const response = await app.request("/failure");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: 409,
      code: "PREVIEW_CHANGED",
      preview: { token: "latest-token" },
    });
  });

  it("does not expose an unexpected exception message", async () => {
    const app = new Hono();
    app.onError((_error, c) => problem(c, "INTERNAL_ERROR", "服务器内部错误", 500));
    app.get("/failure", () => {
      throw new Error("database password=local-secret");
    });

    const response = await app.request("/failure");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("local-secret");
  });
});
