import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("admin users API v1", () => {
  it("requires an administrator and validates pagination strictly", async () => {
    const fixture = await createApiFixture();
    try {
      expect((await fixture.request("/api/v1/admin/users")).status).toBe(401);
      const headers = await fixture.signIn("superAdmin");
      const list = await fixture.request("/api/v1/admin/users?page=1&limit=20", { headers });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        data: expect.any(Array),
        pagination: { page: 1, limit: 20, total: expect.any(Number) },
      });
      for (const query of ["page=abc", "page=0", "page=1.5", "page=1e3", "limit=101", "limit=20abc"]) {
        const response = await fixture.request(`/api/v1/admin/users?${query}`, { headers });
        expect(response.status, query).toBe(400);
      }
    } finally {
      await fixture.close();
    }
  });

  it("accepts exactly one user property and preserves plugin role permissions", async () => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      const superHeaders = await fixture.signIn("superAdmin");
      superHeaders.set("content-type", "application/json");
      const banned = await fixture.request(`/api/v1/admin/users/${target.user.id}`, {
        method: "PATCH",
        headers: superHeaders,
        body: JSON.stringify({ banned: true }),
      });
      expect(banned.status).toBe(200);
      expect(await banned.json()).toEqual({ data: { id: target.user.id, banned: true } });

      const invalid = await fixture.request(`/api/v1/admin/users/${target.user.id}`, {
        method: "PATCH",
        headers: superHeaders,
        body: JSON.stringify({ banned: false, role: "admin" }),
      });
      expect(invalid.status).toBe(400);

      const adminHeaders = await fixture.signIn("admin");
      adminHeaders.set("content-type", "application/json");
      const forbidden = await fixture.request(`/api/v1/admin/users/${target.user.id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await fixture.close();
    }
  });
});
