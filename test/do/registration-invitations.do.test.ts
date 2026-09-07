import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InvitationError,
  claimInvitation,
  completeInvitation,
  createRegistrationInvitation,
  handleInvitationSignup,
  listRegistrationInvitations,
  releaseInvitation,
  revokeRegistrationInvitation,
} from "../../src/services/registration-invitations";

const NOW = new Date("2026-09-05T06:00:00.000Z");
const FUTURE = "2026-09-12T06:00:00.000Z";

async function insertInvitation(
  code: string,
  overrides: {
    expiresAt?: string;
    revokedAt?: string | null;
    usedAt?: string | null;
  } = {}
) {
  await env.DATABASE.prepare(
    `INSERT INTO registration_invitation
       (code, created_by, created_at, expires_at, revoked_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      code,
      "admin-1",
      NOW.toISOString(),
      overrides.expiresAt ?? FUTURE,
      overrides.revokedAt ?? null,
      overrides.usedAt ?? null
    )
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DATABASE.prepare("DELETE FROM registration_invitation").run();
  await env.DATABASE.prepare("DELETE FROM user_entitlement").run();
  await env.DATABASE.prepare("DELETE FROM entitlement_preset").run();
  await env.DATABASE.prepare("DELETE FROM entitlement_config").run();
});

describe("invitation claim lifecycle", () => {
  it("allows only one concurrent claimant", async () => {
    await insertInvitation("ABCDEFGH");

    const results = await Promise.allSettled([
      claimInvitation(env.DATABASE, "ABCDEFGH", "one@example.com", NOW),
      claimInvitation(env.DATABASE, "ABCDEFGH", "two@example.com", NOW),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "INVITATION_IN_USE",
    });
  });

  it("does not steal an in-flight claim after an arbitrary timeout", async () => {
    await insertInvitation("N4STEAL2");
    await claimInvitation(env.DATABASE, "N4STEAL2", "first@example.com", NOW);
    const muchLater = new Date(NOW.getTime() + 60 * 60 * 1000);

    await expect(
      claimInvitation(env.DATABASE, "N4STEAL2", "second@example.com", muchLater)
    ).rejects.toMatchObject({ code: "INVITATION_IN_USE" });
  });

  it.each([
    ["missing", "M3SS3NG9", {}, "INVALID_INVITATION_CODE"],
    ["expired", "EXP3R3D2", { expiresAt: "2026-09-04T06:00:00.000Z" }, "INVITATION_EXPIRED"],
    ["revoked", "R3V4K3D2", { revokedAt: "2026-09-05T05:00:00.000Z" }, "INVITATION_REVOKED"],
    ["used", "USED2222", { usedAt: "2026-09-05T05:00:00.000Z" }, "INVITATION_USED"],
  ])("rejects a %s invitation with a specific error", async (_label, code, overrides, errorCode) => {
    if (_label !== "missing") await insertInvitation(code, overrides);

    await expect(
      claimInvitation(env.DATABASE, code, "person@example.com", NOW)
    ).rejects.toMatchObject({ code: errorCode });
  });

  it("releases a failed registration so the invitation can be retried", async () => {
    await insertInvitation("RELEASE2");
    const first = await claimInvitation(
      env.DATABASE,
      "RELEASE2",
      "first@example.com",
      NOW
    );

    await releaseInvitation(env.DATABASE, first);

    await expect(
      claimInvitation(env.DATABASE, "RELEASE2", "second@example.com", NOW)
    ).resolves.toMatchObject({ code: "RELEASE2", email: "second@example.com" });
  });

  it("marks a completed invitation as used and does not grant entitlements", async () => {
    await insertInvitation("C4MPLETE");
    const claim = await claimInvitation(
      env.DATABASE,
      "C4MPLETE",
      "new@example.com",
      NOW
    );

    await completeInvitation(env.DATABASE, claim, "new-user", NOW);

    await expect(
      claimInvitation(env.DATABASE, "C4MPLETE", "other@example.com", NOW)
    ).rejects.toMatchObject({ code: "INVITATION_USED" });
    const entitlements = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS count FROM user_entitlement WHERE user_id = ?"
    )
      .bind("new-user")
      .first<{ count: number }>();
    expect(entitlements?.count).toBe(0);
  });
});

describe("invitation administration", () => {
  it("creates a readable code with a seven-day expiry", async () => {
    const created = await createRegistrationInvitation(
      env.DATABASE,
      "admin-7",
      { now: NOW, codeFactory: () => "CREATE22" }
    );

    expect(created).toMatchObject({
      code: "CREATE22",
      createdBy: "admin-7",
      createdAt: NOW.toISOString(),
      expiresAt: FUTURE,
      status: "active",
    });
  });

  it("retries when a generated short code already exists", async () => {
    await insertInvitation("DUPL3CAT");
    const codes = ["DUPL3CAT", "UN3QUE22"];

    const created = await createRegistrationInvitation(
      env.DATABASE,
      "admin-1",
      { now: NOW, codeFactory: () => codes.shift() ?? "UN3QUE22" }
    );

    expect(created.code).toBe("UN3QUE22");
  });

  it("lists current status and revokes an unused invitation", async () => {
    await insertInvitation("R3V4KE22");

    await revokeRegistrationInvitation(env.DATABASE, " r3v4ke22 ", NOW);
    const rows = await listRegistrationInvitations(env.DATABASE, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "R3V4KE22",
      status: "revoked",
      revokedAt: NOW.toISOString(),
    });
  });

  it("does not revoke an invitation that has already been used", async () => {
    await insertInvitation("USED2222", { usedAt: "2026-09-05T05:00:00.000Z" });

    await expect(
      revokeRegistrationInvitation(env.DATABASE, "USED2222", NOW)
    ).rejects.toMatchObject({ code: "INVITATION_USED" });
  });

  it("does not revoke an invitation while registration is in flight", async () => {
    await insertInvitation("3NFL3GHT");
    const claim = await claimInvitation(
      env.DATABASE,
      "3NFL3GHT",
      "person@example.com",
      NOW
    );

    await expect(
      revokeRegistrationInvitation(env.DATABASE, "3NFL3GHT", NOW)
    ).rejects.toMatchObject({ code: "INVITATION_IN_USE" });
    await expect(
      completeInvitation(env.DATABASE, claim, "new-user", NOW)
    ).resolves.toBeUndefined();
  });
});

describe("invitation-only signup boundary", () => {
  it("rejects a missing code without calling Better Auth when invitations are required", async () => {
    let called = false;
    const request = new Request("https://auth.cqu.moe/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "New User",
        email: "new@example.com",
        password: "password123",
      }),
    });

    const response = await handleInvitationSignup(
      request,
      env.DATABASE,
      async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
      NOW
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVITATION_REQUIRED" });
    expect(called).toBe(false);
  });

  it("strips the code before signup and consumes it on success", async () => {
    await insertInvitation("S3GNUP22");
    const request = new Request("https://auth.cqu.moe/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "New User",
        email: "new@example.com",
        password: "password123",
        code: " s3gnup22 ",
      }),
    });

    const response = await handleInvitationSignup(
      request,
      env.DATABASE,
      async (forwarded) => {
        expect(await forwarded.json()).toEqual({
          name: "New User",
          email: "new@example.com",
          password: "password123",
        });
        return Response.json({ user: { id: "user-22" } });
      },
      NOW
    );

    expect(response.status).toBe(200);
    const row = await env.DATABASE.prepare(
      "SELECT used_by_user_id, used_at, claim_token FROM registration_invitation WHERE code = ?"
    )
      .bind("S3GNUP22")
      .first<{ used_by_user_id: string; used_at: string; claim_token: string | null }>();
    expect(row?.used_by_user_id).toBe("user-22");
    expect(row?.used_at).toBe(NOW.toISOString());
    expect(row?.claim_token).toBe(null);
  });

  it("releases the claim when Better Auth rejects the registration", async () => {
    await insertInvitation("FA3LURE2");
    const request = new Request("https://auth.cqu.moe/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Existing User",
        email: "existing@example.com",
        password: "password123",
        code: "FA3LURE2",
      }),
    });

    const response = await handleInvitationSignup(
      request,
      env.DATABASE,
      async () => Response.json({ message: "User already exists" }, { status: 422 }),
      NOW
    );

    expect(response.status).toBe(422);
    await expect(
      claimInvitation(env.DATABASE, "FA3LURE2", "retry@example.com", NOW)
    ).resolves.toBeDefined();
  });

  it("returns the invitation error in Better Auth's client-readable shape", async () => {
    await insertInvitation("EXP3R3D2", { expiresAt: "2026-09-04T06:00:00.000Z" });
    const request = new Request("https://auth.cqu.moe/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "New User",
        email: "new@example.com",
        password: "password123",
        code: "EXP3R3D2",
      }),
    });

    const response = await handleInvitationSignup(
      request,
      env.DATABASE,
      async () => Response.json({ user: { id: "should-not-run" } }),
      NOW
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVITATION_EXPIRED",
      message: "邀请码已过期",
    });
  });

  it("accepts Better Auth's form-encoded signup format", async () => {
    await insertInvitation("F4RM2222");
    const body = new URLSearchParams({
      name: "Form User",
      email: "form@example.com",
      password: "password123",
      code: "f4rm2222",
    });
    const request = new Request("https://auth.cqu.moe/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const response = await handleInvitationSignup(
      request,
      env.DATABASE,
      async (forwarded) => {
        expect(forwarded.headers.get("content-type")).toBe("application/json");
        expect(await forwarded.json()).toEqual({
          name: "Form User",
          email: "form@example.com",
          password: "password123",
        });
        return Response.json({ user: { id: "form-user" } });
      },
      NOW
    );

    expect(response.status).toBe(200);
  });
});

it("InvitationError exposes a stable code for route error mapping", () => {
  expect(new InvitationError("INVITATION_USED", "邀请码已使用").code).toBe(
    "INVITATION_USED"
  );
});

describe("registration entitlements (preset wiring)", () => {
  const signupRequest = (body: Record<string, unknown>) =>
    new Request("https://auth.cqu.moe/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "New User",
        email: "new@example.com",
        password: "password123",
        ...body,
      }),
    });
  const okRegister = async () => Response.json({ user: { id: "user-ent" } });

  async function insertPreset(name: string, items: { subsystem: string; capability: string; value: string }[]) {
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_preset (name, items) VALUES (?, ?)"
    )
      .bind(name, JSON.stringify(items))
      .run();
  }

  async function entitlementRows(userId: string) {
    const result = await env.DATABASE.prepare(
      "SELECT subsystem, capability, value FROM user_entitlement WHERE user_id = ? ORDER BY subsystem, capability"
    )
      .bind(userId)
      .all<{ subsystem: string; capability: string; value: string }>();
    return result.results;
  }

  it("grants the invitation's own preset on signup", async () => {
    await insertPreset("助教", [
      { subsystem: "calendar", capability: "sync", value: "1" },
      { subsystem: "eval", capability: "batch", value: "1" },
    ]);
    await createRegistrationInvitation(env.DATABASE, "admin-1", {
      preset: "助教",
      now: NOW,
      codeFactory: () => "V3PPPP22",
    });

    const response = await handleInvitationSignup(
      signupRequest({ code: "V3PPPP22" }),
      env.DATABASE,
      okRegister,
      NOW
    );

    expect(response.status).toBe(200);
    expect(await entitlementRows("user-ent")).toEqual([
      { subsystem: "calendar", capability: "sync", value: "1" },
      { subsystem: "eval", capability: "batch", value: "1" },
    ]);
  });

  it("invitation preset overrides the global default preset", async () => {
    await insertPreset("学生", [
      { subsystem: "calendar", capability: "sync", value: "1" },
    ]);
    await insertPreset("助教", [
      { subsystem: "eval", capability: "batch", value: "1" },
    ]);
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_config (key, value) VALUES ('default_preset', '学生')"
    ).run();
    await createRegistrationInvitation(env.DATABASE, "admin-1", {
      preset: "助教",
      now: NOW,
      codeFactory: () => "VV3D2222",
    });

    await handleInvitationSignup(
      signupRequest({ code: "VV3D2222" }),
      env.DATABASE,
      okRegister,
      NOW
    );

    // 只含助教项:邀请码预设是完全替代,不是与默认合并。
    expect(await entitlementRows("user-ent")).toEqual([
      { subsystem: "eval", capability: "batch", value: "1" },
    ]);
  });

  it("plain invitation falls back to the global default preset", async () => {
    await insertPreset("学生", [
      { subsystem: "calendar", capability: "sync", value: "1" },
      { subsystem: "calendar", capability: "sub_limit", value: "50" },
    ]);
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_config (key, value) VALUES ('default_preset', '学生')"
    ).run();
    await insertInvitation("PLA3N222");

    await handleInvitationSignup(
      signupRequest({ code: "PLA3N222" }),
      env.DATABASE,
      okRegister,
      NOW
    );

    expect(await entitlementRows("user-ent")).toEqual([
      { subsystem: "calendar", capability: "sub_limit", value: "50" },
      { subsystem: "calendar", capability: "sync", value: "1" },
    ]);
  });

  it("allows signup without a code when invitations are not required, applying the default preset", async () => {
    await insertPreset("学生", [
      { subsystem: "calendar", capability: "sync", value: "1" },
    ]);
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_config (key, value) VALUES ('default_preset', '学生')"
    ).run();
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_config (key, value) VALUES ('invitation_required', '0')"
    ).run();
    let called = false;

    const response = await handleInvitationSignup(
      signupRequest({}),
      env.DATABASE,
      async () => {
        called = true;
        return Response.json({ user: { id: "user-ent" } });
      },
      NOW
    );

    expect(response.status).toBe(200);
    expect(called).toBe(true);
    expect(await entitlementRows("user-ent")).toEqual([
      { subsystem: "calendar", capability: "sync", value: "1" },
    ]);
  });

  it("no-code signup with no default preset leaves the user entitlement-free (fail-closed)", async () => {
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_config (key, value) VALUES ('invitation_required', '0')"
    ).run();

    const response = await handleInvitationSignup(
      signupRequest({}),
      env.DATABASE,
      okRegister,
      NOW
    );

    expect(response.status).toBe(200);
    expect(await entitlementRows("user-ent")).toEqual([]);
  });

  it("empty-string code counts as no code (rejected when required)", async () => {
    const response = await handleInvitationSignup(
      signupRequest({ code: "   " }),
      env.DATABASE,
      okRegister,
      NOW
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVITATION_REQUIRED" });
  });

  it("failed no-code registration does not write entitlements", async () => {
    await env.DATABASE.prepare(
      "INSERT INTO entitlement_config (key, value) VALUES ('invitation_required', '0')"
    ).run();

    const response = await handleInvitationSignup(
      signupRequest({}),
      env.DATABASE,
      async () => Response.json({ message: "User already exists" }, { status: 422 }),
      NOW
    );

    expect(response.status).toBe(422);
    expect(await entitlementRows("user-ent")).toEqual([]);
  });
});
