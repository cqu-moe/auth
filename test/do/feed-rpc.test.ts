import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { AuthService } from "../../src/rpc";
import { createAuth } from "../../src/auth";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});

async function createFeedRpcFixture() {
  const id = crypto.randomUUID();
  const email = `${id}@example.com`;
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  const now = new Date();
  const user = await adapter.create<{ id: string }>({
    model: "user",
    data: {
      name: "Feed RPC user",
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      role: "user",
    },
  });
  const clientId = `feed-${id}`;
  await adapter.create({
    model: "oauthClient",
    data: {
      clientId,
      clientSecret: await hashOAuthClientSecret("feed-rpc-secret"),
      disabled: false,
      redirectUris: ["https://feed.example/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
      metadata: {
        subsystem: "feed",
        rpcMethods: ["getFeedPolicy", "getFeedRecipient"],
      },
    },
  });
  const rpc = new AuthService(createExecutionContext(), env);
  return {
    rpc,
    args: {
      contractVersion: 1,
      clientId,
      clientSecret: "feed-rpc-secret",
      userId: user.id,
    },
    email,
  };
}

async function setFeedEntitlements(userId: string, access: string | null, limit: string | null) {
  await env.DATABASE.prepare(
    "DELETE FROM user_entitlement WHERE user_id = ? AND subsystem = 'feed'"
  ).bind(userId).run();
  const rows: Array<[string, string]> = access === null ? [] : [["access", access]];
  if (limit !== null) rows.push(["sub_limit", limit]);
  for (const [capability, value] of rows) {
    await env.DATABASE.prepare(
      "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'feed', ?, ?)"
    ).bind(userId, capability, value).run();
  }
}

it("getFeedPolicy distinguishes missing, zero, limited, and unlimited subscription quotas", async () => {
  const fixture = await createFeedRpcFixture();
  const cases = [
    { access: "1", limit: null, expected: { kind: "missing" } },
    { access: "1", limit: "0", expected: { kind: "limited", value: 0 } },
    { access: "1", limit: "25", expected: { kind: "limited", value: 25 } },
    { access: "1", limit: "", expected: { kind: "unlimited" } },
  ];

  for (const testCase of cases) {
    await setFeedEntitlements(fixture.args.userId, testCase.access, testCase.limit);
    const result = await fixture.rpc.getFeedPolicy(fixture.args);
    expect(result).toEqual({
      ok: true,
      contractVersion: 1,
      checkedAt: expect.any(Number),
      data: { access: true, subscriptionLimit: testCase.expected },
    });
    expect(Number.isFinite((result as { checkedAt: number }).checkedAt)).toBe(true);
  }
});

it("getFeedRecipient returns policy and email state without leaking unverified or blocked addresses", async () => {
  const fixture = await createFeedRpcFixture();
  await setFeedEntitlements(fixture.args.userId, "1", "10");
  await expect(fixture.rpc.getFeedRecipient(fixture.args)).resolves.toEqual({
    ok: true,
    contractVersion: 1,
    checkedAt: expect.any(Number),
    data: {
      policy: { access: true, subscriptionLimit: { kind: "limited", value: 10 } },
      recipient: { status: "verified", email: fixture.email },
    },
  });

  await env.DATABASE.prepare("UPDATE user SET emailVerified = 0 WHERE id = ?")
    .bind(fixture.args.userId).run();
  const unverified = await fixture.rpc.getFeedRecipient(fixture.args);
  expect(unverified).toMatchObject({
    ok: true,
    data: {
      policy: { access: true, subscriptionLimit: { kind: "limited", value: 10 } },
      recipient: { status: "unverified" },
    },
  });
  expect(JSON.stringify(unverified)).not.toContain(fixture.email);

  await setFeedEntitlements(fixture.args.userId, null, "10");
  const blocked = await fixture.rpc.getFeedRecipient(fixture.args);
  expect(blocked).toMatchObject({
    ok: true,
    data: {
      policy: { access: false, subscriptionLimit: { kind: "limited", value: 10 } },
      recipient: { status: "blocked" },
    },
  });
  expect(JSON.stringify(blocked)).not.toContain(fixture.email);
});

it("keeps policy independent of recipient-only email data", async () => {
  const fixture = await createFeedRpcFixture();
  await setFeedEntitlements(fixture.args.userId, "1", "5");
  await env.DATABASE.prepare("UPDATE user SET email = '' WHERE id = ?")
    .bind(fixture.args.userId).run();

  await expect(fixture.rpc.getFeedPolicy(fixture.args)).resolves.toMatchObject({
    ok: true,
    data: {
      access: true,
      subscriptionLimit: { kind: "limited", value: 5 },
    },
  });
  await expect(fixture.rpc.getFeedRecipient(fixture.args)).resolves.toMatchObject({
    ok: false,
    code: "AUTH_DATA_INVALID",
    retryable: false,
  });
});

it("separates Feed RPC request, client, subject, and entitlement-data failures", async () => {
  const fixture = await createFeedRpcFixture();
  await expect(
    fixture.rpc.getFeedPolicy({ ...fixture.args, contractVersion: 2 })
  ).resolves.toMatchObject({
    ok: false,
    code: "UNSUPPORTED_VERSION",
    retryable: false,
    requestId: expect.any(String),
  });
  await expect(
    fixture.rpc.getFeedPolicy({ ...fixture.args, clientSecret: "wrong-secret" })
  ).resolves.toMatchObject({
    ok: false,
    code: "INVALID_CLIENT",
    retryable: false,
    requestId: expect.any(String),
  });

  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  await adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: fixture.args.clientId }],
    update: {
      metadata: { subsystem: "feed", rpcMethods: ["getFeedRecipient"] },
    },
  });
  await expect(fixture.rpc.getFeedPolicy(fixture.args)).resolves.toMatchObject({
    ok: false,
    code: "CLIENT_NOT_ALLOWED",
    retryable: false,
  });
  await adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: fixture.args.clientId }],
    update: {
      metadata: {
        subsystem: "calendar",
        rpcMethods: ["getFeedPolicy", "getFeedRecipient"],
      },
    },
  });
  await expect(fixture.rpc.getFeedRecipient(fixture.args)).resolves.toMatchObject({
    ok: false,
    code: "CLIENT_NOT_ALLOWED",
    retryable: false,
  });
  await adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: fixture.args.clientId }],
    update: {
      metadata: {
        subsystem: "feed",
        rpcMethods: ["getFeedPolicy", "getFeedRecipient"],
      },
    },
  });

  await setFeedEntitlements(fixture.args.userId, "1", "not-a-number");
  await expect(fixture.rpc.getFeedPolicy(fixture.args)).resolves.toMatchObject({
    ok: false,
    code: "AUTH_DATA_INVALID",
    retryable: false,
  });
  await expect(
    fixture.rpc.getFeedPolicy({ ...fixture.args, userId: "missing-user" })
  ).resolves.toMatchObject({
    ok: false,
    code: "SUBJECT_UNAVAILABLE",
    retryable: false,
  });
});
