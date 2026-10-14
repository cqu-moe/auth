import { describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import { createAuth } from "../../src/auth";
import { AuthService } from "../../src/rpc";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";
import { createApiFixture } from "./api-fixture";

describe("admin entitlements API v1", () => {
  it("grants external calendar rights only through an administrator and preserves their three states", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      const path = `/api/v1/admin/users/${target.user.id}/entitlements`;
      const personal = [
        { subsystem: "calendar", capability: "sync", value: "1" },
        { subsystem: "calendar", capability: "sync_interval", value: "60" },
        { subsystem: "calendar", capability: "manual_refresh", value: "5" },
      ];
      const legacyPersonalUnlimited = personal.map((item) =>
        item.capability === "sync_interval" || item.capability === "manual_refresh"
          ? { ...item, value: "" }
          : item
      );
      const granted = [
        ...personal,
        { subsystem: "calendar", capability: "external", value: "1" },
        { subsystem: "calendar", capability: "external_sync_interval", value: "15" },
        { subsystem: "calendar", capability: "external_manual_refresh", value: "0" },
      ];

      const admin = await fixture.signIn("admin");
      admin.set("content-type", "application/json");
      const rejected = await fixture.request(path, {
        method: "PUT",
        headers: admin,
        body: JSON.stringify({ items: granted }),
      });
      expect(rejected.status).toBe(403);

      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const clientId = `calendar-external-${crypto.randomUUID()}`;
      const clientSecret = "calendar-external-secret";
      const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
      await adapter.create({
        model: "oauthClient",
        data: {
          clientId,
          clientSecret: await hashOAuthClientSecret(clientSecret),
          redirectUris: ["https://schedule.test/callback"],
          tokenEndpointAuthMethod: "client_secret_basic",
          metadata: { subsystem: "calendar", rpcMethods: ["getCaps"] },
        },
      });
      const rpc = new AuthService(createExecutionContext(), env);
      const initial = await rpc.getCaps({ clientId, clientSecret, userId: target.user.id });
      expect(initial).toBeNull();
      expect((await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: legacyPersonalUnlimited }),
      })).status).toBe(200);
      expect(await rpc.getCaps({ clientId, clientSecret, userId: target.user.id })).toMatchObject({
        calendar: { sync_interval: null, manual_refresh: null },
      });
      expect((await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: granted }),
      })).status).toBe(200);
      let rows = await fixture.request(path, { headers })
        .then((response) => response.json() as Promise<{ data: Array<{ subsystem: string; capability: string; value: string }> }>);
      const project = (items: typeof rows.data) => items.map(({ subsystem, capability, value }) => ({ subsystem, capability, value }));
      expect(project(rows.data)).toEqual(expect.arrayContaining(granted));

      let rights = await rpc.getCaps({ clientId, clientSecret, userId: target.user.id });
      expect(rights).toMatchObject({
        calendar: {
          sync_interval: 60,
          manual_refresh: 5,
          external_sync_interval: 15,
          external_manual_refresh: 0,
        },
      });

      expect((await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [
          ...personal,
          { subsystem: "calendar", capability: "external", value: "1" },
          { subsystem: "calendar", capability: "external_sync_interval", value: "0" },
          { subsystem: "calendar", capability: "external_manual_refresh", value: "" },
        ] }),
      })).status).toBe(200);
      rows = await fixture.request(path, { headers })
        .then((response) => response.json() as Promise<{ data: Array<{ subsystem: string; capability: string; value: string }> }>);
      expect(project(rows.data)).toEqual(expect.arrayContaining([
        ...personal,
        { subsystem: "calendar", capability: "external", value: "1" },
        { subsystem: "calendar", capability: "external_sync_interval", value: "0" },
        { subsystem: "calendar", capability: "external_manual_refresh", value: "" },
      ]));
      rights = await rpc.getCaps({ clientId, clientSecret, userId: target.user.id });
      expect(rights).toMatchObject({
        calendar: {
          sync_interval: 60,
          manual_refresh: 5,
          external_sync_interval: 0,
          external_manual_refresh: null,
        },
      });

      expect((await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [
          ...personal,
          { subsystem: "calendar", capability: "external", value: "1" },
          { subsystem: "calendar", capability: "external_sync_interval", value: "14" },
        ] }),
      })).status).toBe(400);
      expect((await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [
          ...personal,
          { subsystem: "calendar", capability: "external", value: "1" },
          { subsystem: "calendar", capability: "external_sync_interval", value: "" },
        ] }),
      })).status).toBe(400);
      expect((await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [
          ...personal,
          { subsystem: "calendar", capability: "external", value: "1" },
        ] }),
      })).status).toBe(200);
      rows = await fixture.request(path, { headers })
        .then((response) => response.json() as Promise<{ data: Array<{ subsystem: string; capability: string; value: string }> }>);
      expect(project(rows.data)).toEqual(expect.arrayContaining([
        ...personal,
        { subsystem: "calendar", capability: "external", value: "1" },
      ]));
      expect(project(rows.data)).not.toContainEqual(
        { subsystem: "calendar", capability: "external_sync_interval", value: "15" }
      );
      expect(project(rows.data)).not.toContainEqual(
        { subsystem: "calendar", capability: "external_manual_refresh", value: "0" }
      );
      rights = await rpc.getCaps({ clientId, clientSecret, userId: target.user.id });
      if (!rights?.calendar) throw new Error("missing calendar caps after revocation");
      expect(rights.calendar).toMatchObject({ external: true, sync_interval: 60, manual_refresh: 5 });
      expect(rights.calendar.external_sync_interval).toBeUndefined();
      expect(rights.calendar.external_manual_refresh).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("keeps external calendar rights out of presets and automatic default grants", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const external = { subsystem: "calendar", capability: "external_sync_interval", value: "30" };
      const safe = { subsystem: "calendar", capability: "sync", value: "1" };

      const create = await fixture.request("/api/v1/admin/entitlement-presets/manual-only", {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [safe, external] }),
      });
      expect(create.status).toBe(400);
      expect(await fixture.database.prepare(
        "SELECT name FROM entitlement_preset WHERE name = 'manual-only'"
      ).first()).toBeNull();

      await fixture.database.prepare(
        `INSERT INTO entitlement_preset (name, items) VALUES ('legacy-manual-only', ?)`
      ).bind(JSON.stringify([external])).run();
      await fixture.database.prepare(
        "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'sync', '1')"
      ).bind(target.user.id).run();
      const merge = await fixture.request(
        `/api/v1/admin/users/${target.user.id}/entitlements`,
        { method: "PATCH", headers, body: JSON.stringify({ preset: "legacy-manual-only" }) }
      );
      expect(merge.status).toBe(409);
      const selectDefault = await fixture.request("/api/v1/admin/entitlement-default", {
        method: "PUT",
        headers,
        body: JSON.stringify({ preset: "legacy-manual-only" }),
      });
      expect(selectDefault.status).toBe(400);
      const rows = await fixture.database.prepare(
        "SELECT subsystem, capability FROM user_entitlement WHERE user_id = ?"
      ).bind(target.user.id).all();
      expect(rows.results).toEqual([{ subsystem: "calendar", capability: "sync" }]);
      expect(await fixture.database.prepare(
        "SELECT value FROM entitlement_config WHERE key = 'default_preset'"
      ).first()).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("rejects invalid media and strict-shape violations before mutating entitlements", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      await fixture.database.prepare(
        "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'sync', '1')"
      ).bind(target.user.id).run();
      const headers = await fixture.signIn("superAdmin");
      const path = `/api/v1/admin/users/${target.user.id}/entitlements`;
      const cases = [
        [{ ...Object.fromEntries(headers), "content-type": "text/plain" }, '{"items":[]}', 415],
        [{ ...Object.fromEntries(headers), "content-type": "application/json" }, "{", 400],
        [{ ...Object.fromEntries(headers), "content-type": "application/json" }, "null", 400],
        [{ ...Object.fromEntries(headers), "content-type": "application/json" }, "[]", 400],
        [{ ...Object.fromEntries(headers), "content-type": "application/json" }, '{"items":[],"extra":true}', 400],
      ] as const;
      for (const [caseHeaders, body, status] of cases) {
        const response = await fixture.request(path, { method: "PUT", headers: caseHeaders, body });
        expect(response.status, body).toBe(status);
        expect(response.headers.get("cache-control"), body).toBe("no-store");
      }
      const rows = await fixture.database.prepare(
        "SELECT subsystem, capability, value FROM user_entitlement WHERE user_id = ?"
      ).bind(target.user.id).all();
      expect(rows.results).toEqual([{ subsystem: "calendar", capability: "sync", value: "1" }]);
    } finally {
      await fixture.close();
    }
  });

  it("distinguishes whole-set replace from preset-key merge", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const path = `/api/v1/admin/users/${target.user.id}/entitlements`;
      const before = [
        { subsystem: "calendar", capability: "share", value: "1" },
        { subsystem: "calendar", capability: "sync", value: "1" },
      ];
      expect((await fixture.request(path, {
        method: "PUT", headers, body: JSON.stringify({ items: before }),
      })).status).toBe(200);
      expect((await fixture.request("/api/v1/admin/entitlement-presets/merge-case", {
        method: "PUT", headers,
        body: JSON.stringify({ items: [{ subsystem: "calendar", capability: "sync", value: "1" }] }),
      })).status).toBe(200);
      expect((await fixture.request(path, {
        method: "PATCH", headers, body: JSON.stringify({ preset: "merge-case" }),
      })).status).toBe(200);
      const result = await fixture.request(path, { headers }).then((response) => response.json()) as {
        data: Array<{ subsystem: string; capability: string; value: string }>;
      };
      expect(result.data.map(({ subsystem, capability, value }) => ({ subsystem, capability, value })))
        .toEqual(expect.arrayContaining(before));
      expect(result.data).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("preserves existing QuickLogin policy while replacing ordinary entitlements", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      await fixture.database.prepare(
        `INSERT INTO user_entitlement (user_id, subsystem, capability, value)
         VALUES (?, 'cqu', 'quicklogin_device_limit', '3'),
                (?, 'cqu', 'quicklogin', '1'),
                (?, 'calendar', 'sync', '1')`
      ).bind(target.user.id, target.user.id, target.user.id).run();
      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const path = `/api/v1/admin/users/${target.user.id}/entitlements`;

      const response = await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          items: [{ subsystem: "calendar", capability: "share", value: "1" }],
        }),
      });
      expect(response.status).toBe(200);
      const rows = await fixture.database.prepare(
        "SELECT subsystem, capability, value FROM user_entitlement WHERE user_id = ? ORDER BY subsystem, capability"
      ).bind(target.user.id).all();
      expect(rows.results).toEqual([
        { subsystem: "calendar", capability: "share", value: "1" },
        { subsystem: "cqu", capability: "quicklogin", value: "1" },
        { subsystem: "cqu", capability: "quicklogin_device_limit", value: "3" },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects direct and preset QuickLogin policy writes without partial mutation", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      await fixture.database.prepare(
        "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'sync', '1')"
      ).bind(target.user.id).run();
      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const path = `/api/v1/admin/users/${target.user.id}/entitlements`;

      const direct = await fixture.request(path, {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [
          { subsystem: "calendar", capability: "share", value: "1" },
          { subsystem: "cqu", capability: "quicklogin_device_limit", value: "0" },
        ] }),
      });
      expect(direct.status).toBe(409);
      expect(await direct.json()).toMatchObject({
        code: "QUICKLOGIN_PREVIEW_REQUIRED",
        status: 409,
      });

      const preset = await fixture.request("/api/v1/admin/entitlement-presets/unsafe", {
        method: "PUT",
        headers,
        body: JSON.stringify({ items: [
          { subsystem: "cqu", capability: "quicklogin", value: "1" },
        ] }),
      });
      expect(preset.status).toBe(409);
      expect(await fixture.database.prepare(
        "SELECT name FROM entitlement_preset WHERE name = 'unsafe'"
      ).first()).toBeNull();

      const rows = await fixture.database.prepare(
        "SELECT subsystem, capability, value FROM user_entitlement WHERE user_id = ?"
      ).bind(target.user.id).all();
      expect(rows.results).toEqual([
        { subsystem: "calendar", capability: "sync", value: "1" },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("blocks preset merge, default selection, and delete paths for QuickLogin policy", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      await fixture.database.prepare(
        `INSERT INTO entitlement_preset (name, items) VALUES ('legacy-unsafe', ?)`
      ).bind(JSON.stringify([
        { subsystem: "cqu", capability: "quicklogin_device_limit", value: "2" },
      ])).run();
      await fixture.database.prepare(
        "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'cqu', 'quicklogin_device_limit', '3')"
      ).bind(target.user.id).run();
      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");

      const merge = await fixture.request(
        `/api/v1/admin/users/${target.user.id}/entitlements`,
        { method: "PATCH", headers, body: JSON.stringify({ preset: "legacy-unsafe" }) }
      );
      expect(merge.status).toBe(409);

      const selectDefault = await fixture.request("/api/v1/admin/entitlement-default", {
        method: "PUT",
        headers,
        body: JSON.stringify({ preset: "legacy-unsafe" }),
      });
      expect(selectDefault.status).toBe(409);

      const remove = await fixture.request(
        `/api/v1/admin/users/${target.user.id}/entitlements/cqu/quicklogin_device_limit`,
        { method: "DELETE", headers }
      );
      expect(remove.status).toBe(409);
      expect(await fixture.database.prepare(
        "SELECT value FROM user_entitlement WHERE user_id = ? AND subsystem = 'cqu' AND capability = 'quicklogin_device_limit'"
      ).bind(target.user.id).first()).toEqual({ value: "3" });
    } finally {
      await fixture.close();
    }
  });
});
