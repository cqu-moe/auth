import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("admin users API v1", () => {
  it.each(["native", "canonical"] as const)("enforces privileged-target ban hierarchy through %s operations", async (entrypoint) => {
    const fixture = await createApiFixture();
    try {
      const targetHeaders = await fixture.signIn("user");
      const target = await fixture.request("/api/v1/auth/get-session", { headers: targetHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      const adminHeaders = await fixture.signIn("admin");
      const superHeaders = await fixture.signIn("superAdmin");
      const mutate = (headers: Headers, userId: string | string[], banned: boolean) => {
        const requestHeaders = new Headers(headers);
        requestHeaders.set("content-type", "application/json");
        requestHeaders.set("origin", env.BETTER_AUTH_URL);
        return fixture.request(entrypoint === "native"
          ? `/api/v1/auth/admin/${banned ? "ban" : "unban"}-user`
          : `/api/v1/admin/users/${userId}`, {
          method: entrypoint === "native" ? "POST" : "PATCH",
          headers: requestHeaders,
          body: JSON.stringify(entrypoint === "native" ? { userId } : { banned }),
        });
      };
      const targetState = () => fixture.database.prepare('SELECT banned, banReason, banExpires FROM "user" WHERE id = ?')
        .bind(target.user.id).first();

      for (const role of ["user", "admin", "superAdmin", "user, admin", "user, superAdmin"]) {
        await fixture.database.prepare('UPDATE "user" SET role = ? WHERE id = ?').bind(role, target.user.id).run();
        expect((await mutate(superHeaders, target.user.id, true)).status, role).toBe(200);
        const bannedState = await targetState();
        expect(bannedState).toMatchObject({ banned: 1 });

        const response = await mutate(adminHeaders, target.user.id, false);
        if (role === "user") {
          expect(response.status).toBe(200);
        } else {
          expect(response.status, role).toBe(403);
          expect(await response.json()).toMatchObject({
            code: entrypoint === "native" ? "CANNOT_UNBAN_ADMINS" : "AUTH_ADMIN_ERROR",
          });
          expect(await targetState()).toEqual(bannedState);
          if (entrypoint === "native") {
            const coercedId = await mutate(adminHeaders, [target.user.id], false);
            expect(coercedId.status, role).toBe(403);
            expect(await coercedId.json()).toMatchObject({ code: "CANNOT_UNBAN_ADMINS" });
            expect(await targetState()).toEqual(bannedState);
            const update = await fixture.request("/api/v1/auth/admin/update-user", {
              method: "POST",
              headers: new Headers({ ...Object.fromEntries(adminHeaders), origin: env.BETTER_AUTH_URL, "content-type": "application/json" }),
              body: JSON.stringify({ userId: target.user.id, data: { banned: false } }),
            });
            expect(update.status).toBe(403);
            expect(await update.json()).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS" });
            expect(await targetState()).toEqual(bannedState);
          }
          expect((await mutate(superHeaders, target.user.id, false)).status, role).toBe(200);
        }
        expect(await targetState()).toEqual({ banned: 0, banReason: null, banExpires: null });
      }

      const caller = await fixture.request("/api/v1/auth/get-session", { headers: adminHeaders })
        .then((response) => response.json() as Promise<{ user: { id: string } }>);
      expect((await mutate(adminHeaders, caller.user.id, false)).status).toBe(403);
      const selfBan = await mutate(adminHeaders, caller.user.id, true);
      expect(selfBan.status).toBe(400);
      if (entrypoint === "native") {
        expect(await selfBan.json()).toMatchObject({ code: "YOU_CANNOT_BAN_YOURSELF" });
      }
    } finally {
      await fixture.close();
    }
  });

  it("requires an administrator and validates pagination strictly", async () => {
    const fixture = await createApiFixture();
    try {
      expect((await fixture.request("/api/v1/admin/users")).status).toBe(401);
      const headers = await fixture.signIn("superAdmin");
      const list = await fixture.request("/api/v1/admin/users?page=1&limit=20", { headers });
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("no-store");
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
      expect(banned.headers.get("cache-control")).toBe("no-store");
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
