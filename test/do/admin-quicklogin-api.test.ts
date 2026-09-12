import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

async function signedInUser(
  fixture: Awaited<ReturnType<typeof createApiFixture>>,
  role: "user" | "admin" | "superAdmin"
) {
  const headers = await fixture.signIn(role);
  const session = await fixture.request("/api/v1/auth/get-session", { headers })
    .then((response) => response.json() as Promise<{ user: { id: string } }>);
  return { headers, userId: session.user.id };
}

describe("admin QuickLogin API v1", () => {
  it("keeps policy initialization and quota changes on canonical v1 resources", async () => {
    const fixture = await createApiFixture();
    try {
      const target = await signedInUser(fixture, "user");
      await env.DATABASE.prepare(
        "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'cqu', 'quicklogin_access', '1')"
      ).bind(target.userId).run();
      const admin = await signedInUser(fixture, "superAdmin");
      admin.headers.set("content-type", "application/json");

      const previewResponse = await fixture.request(
        `/api/v1/admin/users/${target.userId}/quicklogin-policy/preview`,
        {
          method: "POST",
          headers: admin.headers,
          body: JSON.stringify({ migrationId: "api-v1-test", deviceLimit: 2 }),
        }
      );
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("cache-control")).toBe("no-store");
      const previewBody = await previewResponse.json() as {
        data: { previewHash: string; initializations: Array<{ deviceLimit: number }> };
      };
      expect(previewBody.data).toMatchObject({
        initializations: [{ userId: target.userId, deviceLimit: 2, masterEnabled: false }],
      });

      const initialized = await fixture.request(
        `/api/v1/admin/users/${target.userId}/quicklogin-policy/initialize`,
        {
          method: "PUT",
          headers: admin.headers,
          body: JSON.stringify({
            migrationId: "api-v1-test",
            deviceLimit: 2,
            previewHash: previewBody.data.previewHash,
          }),
        }
      );
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        data: { masterEnabled: false, deviceLimit: 2, used: 0, devices: [] },
      });

      const quotaPreview = await fixture.request(
        `/api/v1/admin/users/${target.userId}/quicklogin-quota/preview`,
        {
          method: "POST",
          headers: admin.headers,
          body: JSON.stringify({ deviceLimit: 1 }),
        }
      );
      expect(quotaPreview.status).toBe(200);
      const quota = await quotaPreview.json() as {
        data: { token: string; oldLimit: number; newLimit: number; revision: number };
      };
      expect(quota.data).toMatchObject({ oldLimit: 2, newLimit: 1 });
      expect(quota.data).toMatchObject({ keptDevices: [], disabledDevices: [] });

      const applied = await fixture.request(
        `/api/v1/admin/users/${target.userId}/quicklogin-quota`,
        {
          method: "PUT",
          headers: admin.headers,
          body: JSON.stringify({ token: quota.data.token, newLimit: 1 }),
        }
      );
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({
        data: { deviceLimit: 1, used: 0 },
      });

      const legacy = await fixture.request(
        `/api/admin/users/${target.userId}/quicklogin-quota/preview`,
        {
          method: "POST",
          headers: admin.headers,
          body: JSON.stringify({ deviceLimit: 0 }),
        }
      );
      expect(legacy.status).toBe(404);
      expect(legacy.headers.get("content-type")).toContain("application/problem+json");
      expect(await legacy.json()).toMatchObject({ status: 404, code: "NOT_FOUND" });
    } finally {
      await fixture.close();
    }
  });

  it("checks entitlement permission before validation and leaves D1 and the account DO untouched", async () => {
    const fixture = await createApiFixture();
    try {
      const target = await signedInUser(fixture, "user");
      const admin = await signedInUser(fixture, "admin");
      admin.headers.set("content-type", "application/json");
      const before = await env.DATABASE.prepare(
        "SELECT COUNT(*) AS count FROM user_entitlement WHERE user_id = ?"
      ).bind(target.userId).first<{ count: number }>();

      for (const [method, suffix, body] of [
        ["POST", "quicklogin-policy/preview", { unexpected: true }],
        ["PUT", "quicklogin-policy/initialize", { unexpected: true }],
        ["POST", "quicklogin-quota/preview", { unexpected: true }],
        ["PUT", "quicklogin-quota", { unexpected: true }],
      ] as const) {
        const response = await fixture.request(
          `/api/v1/admin/users/${target.userId}/${suffix}`,
          { method, headers: admin.headers, body: JSON.stringify(body) }
        );
        expect(response.status, `${method} ${suffix}`).toBe(403);
        expect(await response.json()).toMatchObject({ status: 403, code: "FORBIDDEN" });
      }

      const after = await env.DATABASE.prepare(
        "SELECT COUNT(*) AS count FROM user_entitlement WHERE user_id = ?"
      ).bind(target.userId).first<{ count: number }>();
      expect(after).toEqual(before);
      const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
        env.CQU_QUICKLOGIN_ACCOUNT.idFromName(target.userId)
      );
      await expect(runInDurableObject(stub, async (_instance, state) => ({
        owner: await state.storage.get("ownerUserId"),
        account: await state.storage.get("account"),
      }))).resolves.toEqual({ owner: undefined, account: undefined });
    } finally {
      await fixture.close();
    }
  });

  it("rejects unknown fields with Problem Details before policy coordination", async () => {
    const fixture = await createApiFixture();
    try {
      const target = await signedInUser(fixture, "user");
      const admin = await signedInUser(fixture, "superAdmin");
      admin.headers.set("content-type", "application/json");
      const response = await fixture.request(
        `/api/v1/admin/users/${target.userId}/quicklogin-quota/preview`,
        {
          method: "POST",
          headers: admin.headers,
          body: JSON.stringify({ deviceLimit: 1, bypassPreview: true }),
        }
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ status: 400, code: "INVALID_BODY" });
    } finally {
      await fixture.close();
    }
  });
});
