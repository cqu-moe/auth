import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("admin entitlements API v1", () => {
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
});
