import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("admin OAuth API v1", () => {
  it("rejects non-JSON and unknown OAuth write fields without side effects", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("superAdmin");
      const before = await fixture.database.prepare("SELECT COUNT(*) AS count FROM oauthClient").first<{ count: number }>();
      for (const [contentType, body, status] of [
        ["text/plain", '{"redirect_uris":[]}', 415],
        ["application/json", '{"redirect_uris":[],"client_secret":"forbidden"}', 400],
        ["application/json", "null", 400],
      ] as const) {
        const requestHeaders = new Headers(headers);
        requestHeaders.set("content-type", contentType);
        const response = await fixture.request("/api/v1/admin/oauth-clients", {
          method: "POST", headers: requestHeaders, body,
        });
        expect(response.status, body).toBe(status);
        expect(response.headers.get("cache-control"), body).toBe("no-store");
      }
      const after = await fixture.database.prepare("SELECT COUNT(*) AS count FROM oauthClient").first<{ count: number }>();
      expect(after?.count).toBe(before?.count);
    } finally {
      await fixture.close();
    }
  });

  it("requires both CQU scope permissions canonically and retires legacy writes", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("admin");
      headers.set("content-type", "application/json");
      const canonical = await fixture.request(
        "/api/v1/admin/oauth-clients/local-client/scopes", {
          method: "PUT", headers, body: JSON.stringify({ scopes: ["cqu:ticket:jwxt"] }),
        });
      expect(canonical.status).toBe(403);
      const legacy = await fixture.request(
        "/api/admin/oauth-clients/local-client/scopes", {
          method: "PUT", headers, body: JSON.stringify({ scopes: ["cqu:ticket:jwxt"] }),
        });
      expect(legacy.status).toBe(404);
      const row = await fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM oauth_client_cqu_scopes WHERE client_id = ?"
      ).bind("local-client").first<{ count: number }>();
      expect(row?.count).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("returns canonical client fields and atomically replaces scopes", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const created = await fixture.request("/api/v1/admin/oauth-clients", {
        method: "POST",
        headers,
        body: JSON.stringify({
          client_name: "Local client",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "client_secret_basic",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "openid profile",
          type: "web",
        }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const client = await created.json() as { data: { client_id: string; client_secret: string } };
      expect(client.data.client_secret).toBeTruthy();
      const disablePkce = await fixture.request(`/api/v1/admin/oauth-clients/${client.data.client_id}`, {
        method: "PATCH", headers, body: JSON.stringify({ require_pkce: false }),
      });
      expect(disablePkce.status).toBe(400);

      const list = await fixture.request("/api/v1/admin/oauth-clients", { headers });
      const item = (await list.json() as { data: Array<Record<string, unknown>> }).data
        .find((entry) => entry.client_id === client.data.client_id)!;
      expect(item).not.toHaveProperty("id");
      expect(item).not.toHaveProperty("clientId");
      expect(item).not.toHaveProperty("name");
      expect(item).not.toHaveProperty("client_secret");
      expect(item).not.toHaveProperty("clientSecret");

      const scopePath = `/api/v1/admin/oauth-clients/${client.data.client_id}/scopes`;
      const replaced = await fixture.request(scopePath, {
        method: "PUT", headers,
        body: JSON.stringify({ scopes: ["cqu:ticket:jwxt", "cqu:ticket:any"] }),
      });
      expect(replaced.status).toBe(200);
      expect(await replaced.json()).toEqual({
        data: { client_id: client.data.client_id, scopes: ["cqu:ticket:jwxt", "cqu:ticket:any"] },
      });
      const duplicate = await fixture.request(scopePath, {
        method: "PUT", headers,
        body: JSON.stringify({ scopes: ["cqu:ticket:jwxt", "cqu:ticket:jwxt"] }),
      });
      expect(duplicate.status).toBe(400);
      const deviceScope = await fixture.request(scopePath, {
        method: "PUT", headers,
        body: JSON.stringify({ scopes: ["cqu:quicklogin:device"] }),
      });
      expect(deviceScope.status).toBe(400);
      const rows = await fixture.database.prepare(
        "SELECT scope FROM oauth_client_cqu_scopes WHERE client_id = ? ORDER BY scope"
      ).bind(client.data.client_id).all<{ scope: string }>();
      expect(rows.results.map((row) => row.scope)).toEqual(["cqu:ticket:any", "cqu:ticket:jwxt"]);

      const rotated = await fixture.request(
        `/api/v1/admin/oauth-clients/${client.data.client_id}/secrets`,
        { method: "POST", headers, body: "{}" }
      );
      expect(rotated.status).toBe(201);
      expect(rotated.headers.get("cache-control")).toBe("no-store");
      const nextSecret = (await rotated.json() as { data: { client_secret: string } }).data.client_secret;
      expect(nextSecret).toBeTruthy();
      expect(nextSecret).not.toBe(client.data.client_secret);

      const deleted = await fixture.request(
        `/api/v1/admin/oauth-clients/${client.data.client_id}`,
        { method: "DELETE", headers }
      );
      expect(deleted.status).toBe(204);
      const remaining = await fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM oauth_client_cqu_scopes WHERE client_id = ?"
      ).bind(client.data.client_id).first<{ count: number }>();
      expect(remaining?.count).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
