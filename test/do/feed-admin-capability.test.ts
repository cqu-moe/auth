import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createAuth } from "../../src/auth";
import { createApiFixture } from "./api-fixture";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DATABASE.prepare("DELETE FROM user_entitlement").run();
});

async function createClient(subsystem: "feed" | "calendar") {
  const clientId = `${subsystem}-admin-${crypto.randomUUID()}`;
  const clientSecret = "feed-admin-secret";
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  await adapter.create({
    model: "oauthClient",
    data: {
      clientId,
      clientSecret: await hashOAuthClientSecret(clientSecret),
      disabled: false,
      skipConsent: true,
      redirectUris: ["https://feed.test/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
      metadata: { subsystem },
    },
  });
  return { clientId, clientSecret };
}

async function createIntrospectionToken(input: {
  userId: string;
  clientId: string;
}) {
  const auth = createAuth(env, new Request(env.BETTER_AUTH_URL));
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(input.userId);
  const issuer = `${env.BETTER_AUTH_URL}/api/auth`;
  const token = await auth.api.signJWT({
    body: {
      payload: {
        sub: input.userId,
        sid: session!.id,
        azp: input.clientId,
        client_id: input.clientId,
        scope: "openid",
      },
      overrideOptions: {
        jwt: { issuer, audience: issuer, expirationTime: "15m" },
      },
    },
  });
  return token.token;
}

async function introspectToken(input: {
  token: string;
  clientId: string;
  clientSecret: string;
}) {
  const response = await SELF.fetch(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/introspect`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: input.token }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    active: boolean;
    caps?: Record<string, unknown>;
  }>;
}

it("introspects feed.admin through role inheritance and explicit ordinary-user entitlement", async () => {
  const fixture = await createApiFixture();
  try {
  const feed = await createClient("feed");
    const targetHeaders = await fixture.signIn("user");
    const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
      .then((response) => response.json() as Promise<{ user: { id: string } }>);
    const path = `/api/v1/admin/users/${target.user.id}/entitlements`;
    const superAdmin = await fixture.signIn("superAdmin");
    superAdmin.set("content-type", "application/json");
    const targetToken = await createIntrospectionToken({
      userId: target.user.id,
      clientId: feed.clientId,
    });
    const introspectTargetCaps = () => introspectToken({ ...feed, token: targetToken });

    for (const role of ["admin", "superAdmin"] as const) {
      const subjectHeaders = await fixture.signIn(role);
      const subject = await fixture.request("/api/v1/auth/get-session", { headers: subjectHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      const inherited = await introspectToken({
        ...feed,
        token: await createIntrospectionToken({
          userId: subject.user.id,
          clientId: feed.clientId,
        }),
      });
      expect(inherited.active).toBe(true);
      expect(inherited.caps).toEqual({ feed: { access: false, admin: true } });
      await expect(env.DATABASE.prepare(
        "SELECT 1 FROM user_entitlement WHERE user_id = ? AND subsystem = 'feed' AND capability = 'admin'"
      ).bind(subject.user.id).first()).resolves.toBeNull();
    }

    const delegate = await fixture.request(path, {
      method: "PUT",
      headers: superAdmin,
      body: JSON.stringify({ items: [{ subsystem: "feed", capability: "admin", value: "1" }] }),
    });
    expect(delegate.status).toBe(200);
    const delegated = await introspectTargetCaps();
    expect(delegated.active).toBe(true);
    expect(delegated.caps).toEqual({ feed: { access: false, admin: true } });

    const calendar = await createClient("calendar");
    const isolated = await introspectToken({
      ...calendar,
      token: await createIntrospectionToken({
        userId: target.user.id,
        clientId: calendar.clientId,
      }),
    });
    expect(isolated.active).toBe(true);
    expect(isolated.caps).not.toHaveProperty("feed");

    expect((await fixture.request(path, {
      method: "PUT",
      headers: superAdmin,
      body: JSON.stringify({ items: [{ subsystem: "calendar", capability: "sync", value: "1" }] }),
    })).status).toBe(200);
    const revoked = await introspectTargetCaps();
    expect(revoked.active).toBe(true);
    expect(revoked.caps).toEqual({ feed: { access: false, admin: false } });

    const promoted = await fixture.signIn("admin");
    const promotedUser = await fixture.request("/api/v1/auth/get-session", { headers: promoted })
      .then((response) => response.json() as Promise<{ user: { id: string } }>);
    const promotedToken = await createIntrospectionToken({
      userId: promotedUser.user.id,
      clientId: feed.clientId,
    });
    const introspectPromotedCaps = () => introspectToken({ ...feed, token: promotedToken });
    await env.DATABASE.prepare("UPDATE user SET role = 'superAdmin' WHERE id = ?")
      .bind(promotedUser.user.id).run();
    const upgraded = await introspectPromotedCaps();
    expect(upgraded.active).toBe(true);
    expect(upgraded.caps).toEqual({ feed: { access: false, admin: true } });
    await env.DATABASE.prepare("UPDATE user SET role = 'user' WHERE id = ?")
      .bind(promotedUser.user.id).run();
    const downgraded = await introspectPromotedCaps();
    expect(downgraded.active).toBe(true);
    expect(downgraded.caps).toEqual({ feed: { access: false, admin: false } });

    await env.DATABASE.prepare("UPDATE user SET banned = 1 WHERE id = ?")
      .bind(promotedUser.user.id).run();
    await expect(introspectPromotedCaps()).resolves.toMatchObject({ active: false });
  } finally {
    await fixture.close();
  }
});

it("keeps feed.admin out of presets and default grants while retaining explicit admin rights", async () => {
  const fixture = await createApiFixture();
  try {
    const superAdmin = await fixture.signIn("superAdmin");
    superAdmin.set("content-type", "application/json");
    const unsafePreset = [{ subsystem: "feed", capability: "admin", value: "1" }];
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_preset (name, items) VALUES ('unsafe-feed-admin', ?)"
    ).bind(JSON.stringify(unsafePreset)).run();

    expect((await fixture.request("/api/v1/admin/entitlement-presets/new-unsafe", {
      method: "PUT",
      headers: superAdmin,
      body: JSON.stringify({ items: unsafePreset }),
    })).status).toBe(400);
    const targetHeaders = await fixture.signIn("user");
    const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
      .then((response) => response.json() as Promise<{ user: { id: string } }>);
    expect((await fixture.request(
      `/api/v1/admin/users/${target.user.id}/entitlements`,
      { method: "PATCH", headers: superAdmin, body: JSON.stringify({ preset: "unsafe-feed-admin" }) }
    )).status).toBe(409);
    expect((await fixture.request("/api/v1/admin/entitlement-default", {
      method: "PUT",
      headers: superAdmin,
      body: JSON.stringify({ preset: "unsafe-feed-admin" }),
    })).status).toBe(400);
    expect(await env.DATABASE.prepare(
      "SELECT 1 FROM user_entitlement WHERE user_id = ? AND subsystem = 'feed' AND capability = 'admin'"
    ).bind(target.user.id).first()).toBeNull();

    const direct = await fixture.request(
      `/api/v1/admin/users/${target.user.id}/entitlements/feed/admin`,
      { method: "DELETE", headers: superAdmin }
    );
    expect(direct.status).toBe(204);
  } finally {
    await fixture.close();
  }
});
