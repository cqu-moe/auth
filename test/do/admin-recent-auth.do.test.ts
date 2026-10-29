import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth";
import { createApiFixture } from "./api-fixture";

async function fixture() {
  const api = await createApiFixture();
  const targetHeaders = await api.signIn("user");
  const headers = await api.signIn("superAdmin");
  headers.set("content-type", "application/json");
  headers.set("origin", env.BETTER_AUTH_URL);
  const auth = createAuth(env, new Request(env.BETTER_AUTH_URL));
  const target = (await auth.api.getSession({ headers: targetHeaders }))!.user;
  const actor = (await auth.api.getSession({ headers }))!;
  const context = await auth.$context;
  const identifier = `security-proof:${actor.session.id}:admin`;
  const send = (path: string, method: string, body?: unknown) => api.request(path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const removeProof = () => context.internalAdapter.deleteVerificationByIdentifier(identifier);
  const expireProof = () => context.adapter.update({
    model: "verification", where: [{ field: "identifier", value: identifier }],
    update: { expiresAt: new Date(Date.now() - 1) },
  });
  return { api, headers, auth, target, actor, context, identifier, send, removeProof, expireProof };
}

describe("recent administrator authority", () => {
  it.each([
    ["canonical role", (id: string) => [`/api/v1/admin/users/${id}`, "PATCH", { role: "superAdmin" }]],
    ["native role array", (id: string) => ["/api/v1/auth/admin/set-role", "POST", { userId: id, role: ["superAdmin"] }]],
    ["native update role", (id: string) => ["/api/v1/auth/admin/update-user", "POST", { userId: id, data: { role: "superAdmin" } }]],
    ["native create role", () => ["/api/v1/auth/admin/create-user", "POST", { email: `recent-${crypto.randomUUID()}@example.com`, name: "New admin", role: "superAdmin" }]],
    ["native create data role", () => ["/api/v1/auth/admin/create-user", "POST", { email: `recent-${crypto.randomUUID()}@example.com`, name: "New admin", data: { role: ["superAdmin"] } }]],
  ] satisfies Array<[string, (id: string) => [string, string, unknown]]>)("rejects %s without a current admin-purpose proof", async (_label, operation) => {
    const f = await fixture();
    const [path, method, body] = operation(f.target.id);
    await f.removeProof();
    const rejected = await f.send(path, method, body);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(await f.context.internalAdapter.findUserById(f.target.id)).toMatchObject({ role: "user" });
    // An expired proof is different from absence and must not renew admission.
    await f.api.reauthenticateAdmin(f.headers);
    await f.expireProof();
    expect(await (await f.send(path, method, body)).json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect((await f.api.request("/api/v1/admin/users", { headers: f.headers })).status).toBe(200);
    await f.api.reauthenticateAdmin(f.headers);
    const accepted = await f.send(path, method, body);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    if (path.endsWith("/create-user")) {
      expect(await accepted.json()).toMatchObject({ user: { role: "superAdmin" } });
    } else {
      expect(await f.context.internalAdapter.findUserById(f.target.id)).toMatchObject({ role: "superAdmin" });
    }
  });

  it("blocks OAuth credential issuance with stale, wrong-purpose, or cross-session proofs and permits a fresh challenge", async () => {
    const f = await fixture();
    const body = {
      client_name: "Recent authentication client", type: "web",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid",
    };
    const create = () => f.send("/api/v1/admin/oauth-clients", "POST", body);
    const before = await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM oauthClient").first();
    await f.expireProof();
    expect(await (await create()).json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    await f.removeProof();
    // The fixture's fresh MFA proof and session-long strong proof do not imply admin purpose.
    expect(await (await create()).json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    await f.context.internalAdapter.createVerificationValue({
      identifier: `security-proof:another-session:admin`,
      value: JSON.stringify({ userId: f.actor.user.id, method: "password" }),
      expiresAt: new Date(Date.now() + 300_000),
    });
    expect(await (await create()).json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM oauthClient").first()).toEqual(before);
    expect((await f.api.request("/api/v1/admin/oauth-clients", { headers: f.headers })).status).toBe(200);
    await f.api.reauthenticateAdmin(f.headers);
    const accepted = await create();
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const client = (await accepted.json<{ data: { client_id: string; client_secret: string } }>()).data;
    expect(client.client_secret).toBeTruthy();
    const clientPath = `/api/v1/admin/oauth-clients/${client.client_id}`;
    const stored = await env.DATABASE.prepare("SELECT clientSecret FROM oauthClient WHERE clientId = ?").bind(client.client_id).first();
    await f.expireProof();
    for (const [path, method, input] of [
      [clientPath, "PATCH", { metadata: { subsystem: "calendar" } }],
      [`${clientPath}/scopes`, "PUT", { scopes: ["cqu:ticket:jwxt"] }],
      [`${clientPath}/secrets`, "POST", {}],
      [clientPath, "DELETE", undefined],
    ] as const) {
      expect(await (await f.send(path, method, input)).json(), path).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    }
    expect(await env.DATABASE.prepare("SELECT clientSecret FROM oauthClient WHERE clientId = ?").bind(client.client_id).first()).toEqual(stored);
    await f.api.reauthenticateAdmin(f.headers);
    const rotated = await f.send(`${clientPath}/secrets`, "POST", {});
    expect(rotated.status).toBe(201);
    expect((await rotated.json<{ data: { client_secret: string } }>()).data.client_secret).not.toBe(client.client_secret);
    // Recent presence never replaces strong admission.
    await f.context.internalAdapter.deleteVerificationByIdentifier(`security-proof:${f.actor.session.id}:strong`);
    expect(await (await create()).json()).toMatchObject({ code: "STRONG_AUTH_REQUIRED" });
  });

  it("checks recent presence on entitlement, preset, registration, invitation-grant, and QuickLogin commits", async () => {
    const f = await fixture();
    const preset = `recent-${crypto.randomUUID()}`;
    const items = [{ subsystem: "calendar", capability: "sync", value: "1" }];
    expect((await f.send(`/api/v1/admin/entitlement-presets/${preset}`, "PUT", { items })).status).toBe(200);
    await f.expireProof();
    const userPath = `/api/v1/admin/users/${f.target.id}`;
    for (const [path, method, body] of [
      [`${userPath}/entitlements`, "PUT", { items }],
      [`${userPath}/entitlements`, "PATCH", { preset }],
      [`${userPath}/entitlements/calendar/sync`, "DELETE", undefined],
      [`/api/v1/admin/entitlement-presets/${preset}`, "PUT", { items: [] }],
      [`/api/v1/admin/entitlement-presets/${preset}`, "DELETE", undefined],
      ["/api/v1/admin/entitlement-default", "PUT", { preset }],
      ["/api/v1/admin/registration-settings", "PUT", { invitationRequired: true }],
      ["/api/v1/admin/registration-invitations", "POST", { preset }],
      [`${userPath}/quicklogin-policy/initialize`, "PUT", { migrationId: "recent", deviceLimit: 2, previewHash: "stale" }],
      [`${userPath}/quicklogin-quota`, "PUT", { token: "stale", newLimit: 2 }],
    ] as const) {
      const response = await f.send(path, method, body);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    }
    expect((await env.DATABASE.prepare("SELECT * FROM user_entitlement WHERE user_id = ?").bind(f.target.id).all()).results).toEqual([]);
    // Listing and previewing remain available after operation-proof expiry.
    expect((await f.api.request("/api/v1/admin/entitlement-presets", { headers: f.headers })).status).toBe(200);
    await env.DATABASE.prepare(
      "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'cqu', 'quicklogin_access', '1')"
    ).bind(f.target.id).run();
    expect((await f.send(`${userPath}/quicklogin-policy/preview`, "POST", { migrationId: "recent", deviceLimit: 2 })).status).toBe(200);
    expect((await f.send("/api/v1/admin/registration-invitations", "POST", {})).status).toBe(201);
    await f.api.reauthenticateAdmin(f.headers);
    expect((await f.send(`${userPath}/entitlements`, "PUT", { items })).status).toBe(200);
    const admin = await f.api.signIn("admin");
    admin.set("content-type", "application/json");
    const denied = await f.api.request(`${userPath}/entitlements`, { method: "PUT", headers: admin, body: JSON.stringify({ items: [] }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("protects administrator-owned clients at native owner endpoints while preserving ordinary owners", async () => {
    const f = await fixture();
    const metadata = {
      redirect_uris: ["https://owner.example/callback"],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code"], response_types: ["code"], scope: "openid",
    };
    const created = await f.send("/api/v1/auth/oauth2/create-client", "POST", metadata);
    expect(created.ok, await created.clone().text()).toBe(true);
    const client = await created.json<{ client_id: string; client_secret: string }>();
    expect(client.client_secret).toBeTruthy();
    const operations = [
      ["/oauth2/create-client", metadata],
      ["/oauth2/update-client", { client_id: client.client_id, update: { redirect_uris: ["https://owner.example/updated"] } }],
      ["/oauth2/client/rotate-secret", { client_id: client.client_id }],
      ["/oauth2/delete-client", { client_id: client.client_id }],
    ] as const;
    await f.expireProof();
    for (const [path, body] of operations) {
      const rejected = await f.send(`/api/v1/auth${path}`, "POST", body);
      expect(rejected.status, path).toBe(403);
      expect(await rejected.json(), path).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    }
    await f.api.reauthenticateAdmin(f.headers);
    for (const [path, body] of operations) {
      const accepted = await f.send(`/api/v1/auth${path}`, "POST", body);
      expect(accepted.ok, `${path}: ${await accepted.clone().text()}`).toBe(true);
    }
    const ordinary = await f.api.signIn("user");
    ordinary.set("origin", env.BETTER_AUTH_URL);
    ordinary.set("content-type", "application/json");
    const ordinaryClient = await f.api.request("/api/v1/auth/oauth2/create-client", { method: "POST", headers: ordinary, body: JSON.stringify(metadata) });
    expect(ordinaryClient.ok, await ordinaryClient.clone().text()).toBe(true);
    const { client_id } = await ordinaryClient.json<{ client_id: string }>();
    const rotation = await f.api.request("/api/v1/auth/oauth2/client/rotate-secret", { method: "POST", headers: ordinary, body: JSON.stringify({ client_id }) });
    expect(rotation.ok, await rotation.clone().text()).toBe(true);
  });
});
