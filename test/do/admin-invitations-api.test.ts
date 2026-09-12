import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("registration resources v1", () => {
  it("exposes only the public policy and rejects malformed invitation JSON without writes", async () => {
    const fixture = await createApiFixture();
    try {
      const publicResponse = await fixture.request("/api/v1/registration-settings");
      expect(publicResponse.status).toBe(200);
      expect(Object.keys((await publicResponse.json() as { data: object }).data))
        .toEqual(["invitationRequired"]);

      const headers = await fixture.signIn("superAdmin");
      headers.set("content-type", "application/json");
      const before = await fixture.database.prepare("SELECT COUNT(*) AS count FROM registration_invitation").first<{ count: number }>();
      const malformed = await fixture.request("/api/v1/admin/registration-invitations", {
        method: "POST",
        headers,
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("cache-control")).toBe("no-store");
      const after = await fixture.database.prepare("SELECT COUNT(*) AS count FROM registration_invitation").first<{ count: number }>();
      expect(after?.count).toBe(before?.count);
    } finally {
      await fixture.close();
    }
  });

  it("creates and revokes invitations and restricts policy writes", async () => {
    const fixture = await createApiFixture();
    try {
      const superHeaders = await fixture.signIn("superAdmin");
      const created = await fixture.request("/api/v1/admin/registration-invitations", {
        method: "POST",
        headers: superHeaders,
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const invitation = await created.json() as { data: { code: string } };
      expect(invitation.data.code).toMatch(/^[A-Z0-9]{8}$/);
      const revoked = await fixture.request(
        `/api/v1/admin/registration-invitations/${invitation.data.code}`,
        { method: "DELETE", headers: superHeaders }
      );
      expect(revoked.status).toBe(204);

      const adminHeaders = await fixture.signIn("admin");
      adminHeaders.set("content-type", "application/json");
      const forbidden = await fixture.request("/api/v1/admin/registration-settings", {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ invitationRequired: false }),
      });
      expect(forbidden.status).toBe(403);

      superHeaders.set("content-type", "application/json");
      const changed = await fixture.request("/api/v1/admin/registration-settings", {
        method: "PUT",
        headers: superHeaders,
        body: JSON.stringify({ invitationRequired: false }),
      });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("cache-control")).toBe("no-store");
      expect(await changed.json()).toEqual({ data: { invitationRequired: false } });
      expect(await fixture.request("/api/v1/registration-settings").then((response) => response.json()))
        .toEqual({ data: { invitationRequired: false } });
    } finally {
      await fixture.close();
    }
  });
});
