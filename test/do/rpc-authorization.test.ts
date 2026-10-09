import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { AuthService } from "../../src/rpc";
import { createAuth } from "../../src/auth";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
async function fixture() {
  const id = crypto.randomUUID();
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  const now = new Date();
  const user = await adapter.create<{ id: string }>({ model: "user", data: { name: "RPC user", email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now, role: "user" } });
  await adapter.create({ model: "oauthClient", data: { clientId: id, clientSecret: await hashOAuthClientSecret("rpc-test-secret"), redirectUris: ["https://schedule.example/callback"], tokenEndpointAuthMethod: "client_secret_basic", metadata: { subsystem: "calendar", rpcMethods: ["getCaps", "cquHarvest", "getCquTicket"] } } });
  await env.DATABASE.prepare("INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'sync', '1')").bind(user.id).run();
  await env.DATABASE.prepare("INSERT INTO cqu_credentials (id, user_id, student_id, encrypted_password, iv) VALUES (?, ?, 'student', 'encrypted', 'iv')").bind(id, user.id).run();
  await env.DATABASE.prepare("INSERT INTO oauth_client_cqu_scopes (client_id, scope) VALUES (?, 'cqu:ticket:jwxt')").bind(id).run();
  const fetch = vi.fn(async () => Response.json({ captures: [], fetches: [], ticket: "ST-test" }));
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
  const rpc = new AuthService(createExecutionContext(), { ...env, CQU_SESSION: namespace });
  const args = { clientId: id, clientSecret: "rpc-test-secret", userId: user.id };
  const harvest = () => rpc.cquHarvest({ ...args, navUrl: "https://my.cqu.edu.cn/workspace/curriculum" });
  const updateClient = (update: Record<string, unknown>) => adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: id }], update });
  return { rpc, args, harvest, fetch, adapter, updateClient };
}

it("checks real service secret, approved method and current user before private RPC dispatch", async () => {
  const f = await fixture();
  expect(await f.harvest()).toMatchObject({ captures: [], fetches: [] });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(await f.rpc.cquHarvest({ ...f.args, clientSecret: "wrong", navUrl: "https://my.cqu.edu.cn" })).toEqual({ error: "INVALID_CLIENT" });
  await f.updateClient({ disabled: true });
  expect(await f.harvest()).toEqual({ error: "INVALID_CLIENT" });
  await f.updateClient({ disabled: false, metadata: { subsystem: "calendar", rpcMethods: ["getCaps"] } });
  expect(await f.rpc.getCaps(f.args)).toMatchObject({ calendar: { sync: true } });
  expect(await f.harvest()).toEqual({ error: "FORBIDDEN" });
  await f.updateClient({ metadata: { subsystem: "calendar", rpcMethods: ["getCaps", "cquHarvest"] } });
  await f.adapter.update({ model: "user", where: [{ field: "id", value: f.args.userId }], update: { banned: true } });
  expect(await f.rpc.getCaps(f.args)).toBeNull();
  expect(await f.harvest()).toEqual({ error: "FORBIDDEN" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("separates method rights, business rights, target scope and school binding", async () => {
  const f = await fixture();
  expect(await f.rpc.getCquTicket({ ...f.args, service: "jwxt" })).toEqual({ ticket: "ST-test" });
  expect(await f.rpc.getCquTicket({ ...f.args, service: "jxpj" })).toEqual({ error: "FORBIDDEN" });
  await env.DATABASE.prepare("DELETE FROM oauth_client_cqu_scopes WHERE client_id = ?").bind(f.args.clientId).run();
  expect(await f.rpc.getCquTicket({ ...f.args, service: "jwxt" })).toEqual({ error: "FORBIDDEN" });
  await env.DATABASE.prepare("DELETE FROM user_entitlement WHERE user_id = ?").bind(f.args.userId).run();
  expect(await f.harvest()).toEqual({ error: "FORBIDDEN" });
  await env.DATABASE.prepare("INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'sync', '1')").bind(f.args.userId).run();
  await env.DATABASE.prepare("INSERT INTO cqu_bind_addresses (token, user_id, sender_whitelist, status) VALUES (?, ?, '[]', 'deleting')").bind(crypto.randomUUID(), f.args.userId).run();
  expect(await f.harvest()).toEqual({ error: "NO_CQU_BINDING" });
  await env.DATABASE.prepare("UPDATE cqu_bind_addresses SET status = 'revoked' WHERE user_id = ?").bind(f.args.userId).run();
  expect(await f.harvest()).toEqual({ error: "NO_CQU_BINDING" });
  await env.DATABASE.prepare("DELETE FROM cqu_credentials WHERE user_id = ?").bind(f.args.userId).run();
  expect(await f.harvest()).toEqual({ error: "NO_CQU_BINDING" });
  expect(await f.rpc.getCaps(f.args)).toMatchObject({ calendar: { sync: true } });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("keeps backend access independent of interactive credentials and rejects missing identities", async () => {
  const f = await fixture();
  const context = await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context;
  await context.internalAdapter.createSession(f.args.userId);
  await context.internalAdapter.deleteUserSessions(f.args.userId);
  // Password change/reset only changes the interactive account credential.
  await f.adapter.create({ model: "account", data: { userId: f.args.userId, accountId: f.args.userId, providerId: "credential", password: "replaced-hash", createdAt: new Date(), updatedAt: new Date() } });
  expect(await f.harvest()).toMatchObject({ captures: [] });
  expect(await f.rpc.getCaps({ ...f.args, userId: "missing-user" })).toBeNull();
  expect(await f.rpc.getCaps({ ...f.args, clientId: "missing-client" })).toBeNull();
  await f.updateClient({ metadata: { subsystem: "calendar" } });
  expect(await f.harvest()).toEqual({ error: "FORBIDDEN" });
});

it.each([
  "WAF_BOOTSTRAP_TIMEOUT", "APP_READY_TIMEOUT", "TABLE_CAPTURE_TIMEOUT",
  "TABLE_REQUEST_HUNG", "TABLE_BODY_TIMEOUT", "TABLE_API_REJECTED", "WAF_CHALLENGE",
  "SCHEDULE_NOT_PUBLISHED", "HARVEST_TRANSIENT", "TGT_EXPIRED", "BROWSER_INSTANCE_REPLACED",
])("keeps DO failure %s opaque after genuine service authorization", async (code) => {
  const f = await fixture();
  f.fetch.mockImplementation(async () => Response.json({ code, error: "SECRET", diagnostics: { secret: "SECRET" } }, { status: 503 }));
  expect(await f.harvest()).toEqual({ error: code });
});

it("only accepts RPC approvals written through the administrator-owned metadata path", async () => {
  const { createApiFixture } = await import("./api-fixture");
  const http = await createApiFixture();
  const owner = await http.signIn("user");
  owner.set("content-type", "application/json");
  owner.set("origin", env.BETTER_AUTH_URL);
  const metadata = { subsystem: "calendar", rpcMethods: ["getCaps", "cquHarvest"] };
  const created = await http.request("/api/v1/auth/oauth2/create-client", { method: "POST", headers: owner, body: JSON.stringify({ client_name: "untrusted-owner", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "client_secret_basic", metadata }) });
  expect(created.status).toBe(201);
  const client = await created.json() as { client_id: string; client_secret: string };
  const f = await fixture();
  const args = { ...f.args, clientId: client.client_id, clientSecret: client.client_secret };
  expect(await f.rpc.getCaps(args)).toBeNull();
  const modified = await http.request("/api/v1/auth/oauth2/update-client", { method: "POST", headers: owner, body: JSON.stringify({ client_id: client.client_id, update: { client_name: "renamed", metadata } }) });
  expect(modified.status).toBe(200);
  expect(await f.rpc.getCaps(args)).toBeNull();
  const registered = await http.request("/api/v1/auth/oauth2/register", { method: "POST", headers: owner, body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], metadata, rpcMethods: metadata.rpcMethods }) });
  expect(registered.status).toBe(403);
  const admin = await http.signIn("superAdmin");
  admin.set("content-type", "application/json");
  const approved = await http.request(`/api/v1/admin/oauth-clients/${client.client_id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ metadata }) });
  expect(approved.status).toBe(200);
  expect(await f.rpc.getCaps(args)).toMatchObject({ calendar: { sync: true } });
});
