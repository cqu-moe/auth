import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createHttpFixture } from "./test-utils/http";

describe("API and SPA routing boundary", () => {
  it.each(["/api", "/api/", "/api/v1/does-not-exist", "/api/v99/health", "/api/unknown"])(
    "keeps unknown API path %s out of ASSETS",
    async (path) => {
      const fixture = createHttpFixture();
      try {
        const response = await createApp().request(path, {}, fixture.env);
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        expect(await response.json()).toMatchObject({ status: 404, code: "NOT_FOUND" });
        expect(fixture.assetsFetch).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    }
  );

  it.each(["/login", "/settings", "/oauth/authorize", "/assets/app.js"])(
    "continues to route page path %s to ASSETS",
    async (path) => {
      const fixture = createHttpFixture();
      try {
        const response = await createApp().request(path, {}, fixture.env);
        expect(response.status).toBe(200);
        expect(fixture.assetsFetch).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.close();
      }
    }
  );

  it("serves canonical health and adapts the legacy response", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const canonical = await app.request("/api/v1/health", {}, fixture.env);
      expect(canonical.status).toBe(200);
      expect(await canonical.json()).toMatchObject({ data: { status: "ok" } });

      const legacy = await app.request("/api/health", {}, fixture.env);
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toMatchObject({ status: "ok", version: "d1native-fix" });
    } finally {
      await fixture.close();
    }
  });

  it("returns 405 and Allow for a known path without invoking its handler", async () => {
    const fixture = createHttpFixture();
    try {
      const response = await createApp().request("/api/v1/health", {
        method: "POST",
        body: "sensitive-body-must-not-be-read",
      }, fixture.env);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect(await response.json()).toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
      expect(fixture.assetsFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("supports HEAD for ordinary GET, excludes websocket HEAD, and handles preflight without business work", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const head = await app.request("/api/v1/health", { method: "HEAD" }, fixture.env);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const websocketHead = await app.request("/api/cqu/binding/events", {
        method: "HEAD",
      }, fixture.env);
      expect(websocketHead.status).toBe(405);
      expect(websocketHead.headers.get("allow")).toBe("GET, OPTIONS");

      const preflight = await app.request("/api/v1/health", {
        method: "OPTIONS",
        headers: {
          origin: "https://schedule.cqu.moe",
          "access-control-request-method": "GET",
        },
      }, fixture.env);
      expect(preflight.status).toBe(204);
      expect(fixture.doFetch).not.toHaveBeenCalled();
      expect(fixture.assetsFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
