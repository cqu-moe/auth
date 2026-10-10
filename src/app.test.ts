import { describe, expect, it, vi } from "vitest";
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

  it("serves canonical health and retires the legacy health prefix", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const canonical = await app.request("/api/v1/health", {}, fixture.env);
      expect(canonical.status).toBe(200);
      expect(await canonical.json()).toMatchObject({ data: { status: "ok" } });

      const legacy = await app.request("/api/health", {}, fixture.env);
      expect(legacy.status).toBe(404);
      expect(await legacy.json()).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(fixture.assetsFetch).not.toHaveBeenCalled();
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
      expect(websocketHead.status).toBe(404);

      const preflight = await app.request("/api/v1/health", {
        method: "OPTIONS",
        headers: {
          origin: "https://schedule.cqu.moe",
          "access-control-request-method": "GET",
        },
      }, fixture.env);
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
      expect(fixture.doFetch).not.toHaveBeenCalled();
      expect(fixture.assetsFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it.each([
    "/api/v1/does-not-exist",
    "/api/auth/get-session",
    "/api/unknown",
  ])("does not synthesize a preflight for unknown or retired path %s", async (path) => {
    const fixture = createHttpFixture();
    try {
      const response = await createApp().request(path, {
        method: "OPTIONS",
        headers: {
          origin: "https://schedule.cqu.moe",
          "access-control-request-method": "GET",
        },
      }, fixture.env);
      expect(response.status).toBe(path === "/api/auth/get-session" ? 404 : 404);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
      expect(fixture.assetsFetch).not.toHaveBeenCalled();
      expect(fixture.doFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("mounts generated auth operations canonically and rejects retired legacy operations", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const canonical = await app.request("/api/v1/auth/ok", {}, fixture.env);
      expect(canonical.status).toBe(200);
      expect(await canonical.json()).toEqual({ ok: true });
      const legacy = await app.request("/api/auth/ok", {}, fixture.env);
      expect(legacy.status).toBe(404);

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

  it("redirects canonical auth errors safely and keeps all issuer discovery variants stable", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const response = await app.request("/api/v1/auth/error?error=boom&description=secret", {}, fixture.env);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/auth/error");
      const retired = await app.request("/api/auth/error?error=boom&redirect=https://evil.test", {}, fixture.env);
      expect(retired.status).toBe(404);

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

  it("retires legacy OAuth, reset callback, and device routes", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      for (const [method, path] of [
        ["GET", "/api/auth/oauth2/authorize"],
        ["POST", "/api/auth/oauth2/token"],
        ["GET", "/api/auth/reset-password/local-token"],
        ["GET", "/api/cqu/quicklogin/devices"],
        ["POST", "/api/cqu/quicklogin/devices/local-device/status"],
      ] as const) {
        const response = await app.request(path, { method }, fixture.env);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.json(), `${method} ${path}`).toMatchObject({
          status: 404,
          code: "NOT_FOUND",
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it.each([
    "chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook",
    "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd",
  ])("accepts only configured extension CORS while retaining bearer and website guards: %s", async origin => {
    const fixture = createHttpFixture();
    Object.assign(fixture.env, {
      QUICKLOGIN_EXTENSION_ORIGIN: "chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook",
      QUICKLOGIN_STORE_EXTENSION_ORIGIN: "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd",
      QUICKLOGIN_DEVICE_MODE: "on",
    });
    try {
      const app = createApp();
      for (const path of ["devices", "registrations", "devices/any/reconcile"]) {
        const url = `/api/v1/cqu/quicklogin/${path}`;
        const preflight = await app.request(url, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST" },
        }, fixture.env);
        expect(preflight.status, path).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin"), path).toBe(origin);
        expect(preflight.headers.get("access-control-allow-credentials"), path).toBeNull();
        const unauthenticated = await app.request(url, {
          method: "POST", headers: { origin },
        }, fixture.env);
        expect(unauthenticated.status, path).toBe(401);
        expect(unauthenticated.headers.get("access-control-allow-origin"), path).toBe(origin);
      }
      for (const [path, method] of [["overview", "GET"], ["devices/any/resume-ticket", "POST"]]) {
        const response = await app.request(`/api/v1/cqu/quicklogin/${path}`, {
          method, headers: { origin, authorization: "Bearer invalid" },
        }, fixture.env);
        expect(response.status, path).toBe(401);
        expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
        const preflight = await app.request(`/api/v1/cqu/quicklogin/${path}`, {
          method: "OPTIONS", headers: { origin, "access-control-request-method": method },
        }, fixture.env);
        expect(preflight.status, path).toBe(403);
        expect(preflight.headers.get("access-control-allow-origin"), path).toBeNull();
      }
    } finally { await fixture.close(); }
  });

  it.each([
    undefined,
    "*",
    "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd.attacker.example",
    "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd/",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "https://ainapeknaclcpoioimonkodmoakhacjd",
  ])("rejects missing or unlisted extension Origins without CORS: %s", async origin => {
    const fixture = createHttpFixture();
    Object.assign(fixture.env, {
      QUICKLOGIN_EXTENSION_ORIGIN: "chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook",
      QUICKLOGIN_STORE_EXTENSION_ORIGIN: "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd",
      QUICKLOGIN_DEVICE_MODE: "on",
    });
    try {
      const app = createApp();
      for (const path of ["devices", "registrations", "devices/any/reconcile"]) {
        for (const method of ["OPTIONS", "POST"]) {
          const response = await app.request(`/api/v1/cqu/quicklogin/${path}`, {
            method,
            headers: { ...(origin ? { origin } : {}), "access-control-request-method": "POST" },
          }, fixture.env);
          expect(response.status, `${method} ${path}`).toBe(403);
          expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
        }
      }
    } finally { await fixture.close(); }
  });

  it("logs only anonymous normalized legacy telemetry", async () => {
    const fixture = createHttpFixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await createApp().request(
        "/api/cqu/quicklogin/devices/device-secret/status?token=query-secret",
        {
          method: "POST",
          headers: {
            authorization: "Bearer bearer-secret",
            cookie: "session=cookie-secret",
            origin: fixture.env.QUICKLOGIN_EXTENSION_ORIGIN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ private: "body-secret" }),
        },
        fixture.env
      );
      expect(response.status).not.toBe(200);
      const entries = info.mock.calls.map(([entry]) => JSON.parse(String(entry)));
      expect(entries).toContainEqual({
        event: "api.legacy_rejected",
        method: "POST",
        route: "/api/cqu/quicklogin/devices/*",
        status: response.status,
      });
      const serialized = JSON.stringify(entries);
      for (const secret of [
        "device-secret", "query-secret", "bearer-secret", "cookie-secret", "body-secret",
      ]) expect(serialized).not.toContain(secret);

      await createApp().request("/api/auth/get-session?token=another-secret", {
        headers: { cookie: "session=another-cookie" },
      }, fixture.env);
      expect(info.mock.calls.map(([entry]) => JSON.parse(String(entry))))
        .toContainEqual({
          event: "api.legacy_rejected",
          method: "GET",
          route: "/api/auth/*",
          status: 404,
        });
    } finally {
      info.mockRestore();
      await fixture.close();
    }
  });
});
