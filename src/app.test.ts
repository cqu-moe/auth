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

  it("mounts only the generated auth operations at canonical and legacy prefixes", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      for (const path of ["/api/v1/auth/ok", "/api/auth/ok"]) {
        const response = await app.request(path, {}, fixture.env);
        expect(response.status, path).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      }

      const wrongMethod = await app.request("/api/v1/auth/get-session", {
        method: "POST",
      }, fixture.env);
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD, OPTIONS");

      for (const path of [
        "/api/v1/auth/devices",
        "/api/auth/devices",
        "/api/v1/auth/sign-in/email-otp",
        "/api/auth/sign-in/email-otp",
      ]) {
        const response = await app.request(path, { method: "POST" }, fixture.env);
        expect(response.status, path).toBe(404);
        expect(response.headers.get("content-type"), path).toContain("application/problem+json");
      }
    } finally {
      await fixture.close();
    }
  });

  it("redirects auth errors safely and keeps all issuer discovery variants stable", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      for (const path of ["/api/v1/auth/error?error=boom&description=secret", "/api/auth/error?error=boom&redirect=https://evil.test"]) {
        const response = await app.request(path, {}, fixture.env);
        expect(response.status, path).toBe(302);
        expect(response.headers.get("location"), path).toBe("/auth/error");
      }

      const discovery = [
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
        "/api/auth/.well-known/openid-configuration",
        "/api/auth/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/api/auth",
      ];
      for (const path of discovery) {
        const response = await app.request(path, {}, fixture.env);
        expect(response.status, path).toBe(200);
        expect(await response.json(), path).toMatchObject({
          issuer: "http://localhost:8787/api/auth",
          authorization_endpoint: "http://localhost:8787/api/v1/auth/oauth2/authorize",
          token_endpoint: "http://localhost:8787/api/v1/auth/oauth2/token",
          jwks_uri: "http://localhost:8787/api/v1/auth/jwks",
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("forwards legacy OAuth form and callback requests without HTTP redirects", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const form = "grant_type=authorization_code&code=invalid&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback";
      const init = {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic Zml4dHVyZS1jbGllbnQ6bG9jYWwtc2VjcmV0",
        },
        body: form,
      } satisfies RequestInit;
      const canonical = await app.request("/api/v1/auth/oauth2/token?trace=signed%2Bvalue", init, fixture.env);
      const legacy = await app.request("/api/auth/oauth2/token?trace=signed%2Bvalue", init, fixture.env);
      expect(legacy.status).toBe(canonical.status);
      expect(legacy.status).not.toBe(301);
      expect(legacy.status).not.toBe(302);
      expect(await legacy.text()).toBe(await canonical.text());
    } finally {
      await fixture.close();
    }
  });
});
