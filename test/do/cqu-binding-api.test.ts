import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("CQU binding API v1", () => {
  it("returns the canonical envelope while preserving the legacy shape", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const canonical = await fixture.request("/api/v1/cqu/binding", { headers });
      expect(canonical.status).toBe(200);
      expect(await canonical.json()).toMatchObject({
        data: { bindStatus: "unbound", sessionStatus: expect.any(Object) },
      });

      const legacy = await fixture.request("/api/cqu/binding", { headers });
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toMatchObject({
        bindStatus: "unbound",
        sessionStatus: expect.any(Object),
      });
    } finally {
      await fixture.close();
    }
  });

  it("uses Problem Details for canonical authentication failures", async () => {
    const fixture = await createApiFixture();
    try {
      const response = await fixture.request("/api/v1/cqu/binding");
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    } finally {
      await fixture.close();
    }
  });

  it("rejects identity injection and keeps forward creation disabled", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      headers.set("content-type", "application/json");
      const injected = await fixture.request("/api/v1/cqu/binding", {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: "other-user" }),
      });
      expect(injected.status).toBe(400);
      expect(await injected.json()).toMatchObject({ code: "INVALID_BODY" });

      const forward = await fixture.request("/api/v1/cqu/binding", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "forward" }),
      });
      expect(forward.status).toBe(403);
      expect(await forward.json()).toMatchObject({ code: "FORWARD_MODE_DISABLED" });
    } finally {
      await fixture.close();
    }
  });

  it("creates one direct binding idempotently and deletes both facts", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const created = await fixture.request("/api/v1/cqu/binding", {
        method: "POST",
        headers,
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        data: { status: "pending", address: expect.stringContaining("@cquotp.com") },
      });
      const repeated = await fixture.request("/api/v1/cqu/binding", {
        method: "POST",
        headers,
      });
      expect(repeated.status).toBe(200);
      const rows = await fixture.database.prepare("SELECT COUNT(*) AS count FROM cqu_bind_addresses").first<{ count: number }>();
      expect(rows?.count).toBe(1);

      const deleted = await fixture.request("/api/v1/cqu/binding", {
        method: "DELETE",
        headers,
      });
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe("");
      const after = await fixture.database.prepare("SELECT COUNT(*) AS count FROM cqu_bind_addresses").first<{ count: number }>();
      expect(after?.count).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
