import { describe, expect, it } from "vitest";
import { createRoute, z } from "@hono/zod-openapi";
import { createApiRouter } from "./validation";

const Body = z.strictObject({ enabled: z.boolean() });
const route = createRoute({
  method: "post",
  path: "/settings",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: Body } },
    },
  },
  responses: {
    200: {
      description: "validated",
      content: {
        "application/json": {
          schema: z.object({ data: Body }),
        },
      },
    },
  },
});

function testApp() {
  const app = createApiRouter();
  app.openapi(route, (c) => c.json({ data: c.req.valid("json") }, 200));
  return app;
}

describe("v1 request validation", () => {
  it.each([
    ["malformed JSON", "{", "application/json"],
    ["null", "null", "application/json"],
    ["array", "[]", "application/json"],
    ["unknown field", '{"enabled":true,"userId":"other"}', "application/json"],
    ["wrong value type", '{"enabled":"true"}', "application/json"],
  ])("rejects %s without invoking the handler", async (_name, body, contentType) => {
    const response = await testApp().request("/settings", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 400, code: "INVALID_BODY" });
  });

  it.each([undefined, "text/plain"])(
    "returns 415 for a non-empty JSON write with content-type %s",
    async (contentType) => {
      const headers = contentType ? { "content-type": contentType } : undefined;
      const response = await testApp().request("/settings", {
        method: "POST",
        headers,
        body: '{"enabled":true}',
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
    }
  );
});
