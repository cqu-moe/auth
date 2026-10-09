import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "../../src/auth";

it("upgrades existing account, school binding, entitlements and OAuth client without rebuilding data", async () => {
  const migrationIndex = env.TEST_MIGRATIONS.findIndex(m => m.name.startsWith("0010_"));
  expect(migrationIndex).toBeGreaterThan(0);
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS.slice(0, migrationIndex));
  const now = new Date().toISOString();
  await env.DATABASE.batch([
    env.DATABASE.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('upgrade-user', 'Old User', 'upgrade@example.com', 1, ?, ?, 'user')").bind(now, now),
    env.DATABASE.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('upgrade-account', 'upgrade-user', 'credential', 'upgrade-user', ?, ?, ?)").bind(await hashPassword("existing-local-password"), now, now),
    env.DATABASE.prepare("INSERT INTO cqu_credentials (id, user_id, student_id, encrypted_password, iv) VALUES ('school', 'upgrade-user', '2026123456', 'opaque-school-secret', 'opaque-iv')"),
    env.DATABASE.prepare("INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES ('upgrade-user', 'calendar', 'enabled', 'true')"),
    env.DATABASE.prepare("INSERT INTO oauthClient (id, clientId, redirectUris, public, type, scopes, requirePKCE) VALUES ('upgrade-client-row', 'upgrade-client', '[\"https://client.example/callback\"]', 1, 'user-agent-based', '[\"openid\"]', 0)"),
  ]);
  const schoolBefore = await env.DATABASE.prepare("SELECT * FROM cqu_credentials WHERE id = 'school'").first();
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS.slice(migrationIndex));
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: env.BETTER_AUTH_URL }, body: JSON.stringify({ email: "upgrade@example.com", password: "existing-local-password" }) });
  const auth = createAuth(env, request);
  const signedIn = await auth.handler(request);
  expect(signedIn.status).toBe(200);
  expect(await signedIn.json()).toMatchObject({ user: { id: "upgrade-user" } });
  expect(await env.DATABASE.prepare("SELECT * FROM cqu_credentials WHERE id = 'school'").first()).toEqual(schoolBefore);
  expect(await env.DATABASE.prepare("SELECT value FROM user_entitlement WHERE user_id = 'upgrade-user'").first("value")).toBe("true");
  const client = await (await auth.$context).adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: "upgrade-client" }] });
  expect(client).toMatchObject({ clientId: "upgrade-client", applicationType: "web", tokenEndpointAuthMethod: "none", requirePKCE: true, redirectUris: ["https://client.example/callback"], scopes: ["openid"] });
});
