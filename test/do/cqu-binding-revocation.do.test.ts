import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshStub, seedSession, seedCredentials, driveAlarm, readStorage, spyBrowserFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("CQU binding revocation reconciliation", () => {
  it.each(["deleting", "revoked", "missing"])("denies ticket and harvest when D1 is %s despite an active DO", async (status) => {
    await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
    const stub = freshStub();
    await seedSession(stub);
    await seedCredentials(stub);
    await env.DATABASE.prepare("DELETE FROM cqu_credentials WHERE user_id = 'u1'").run();
    await env.DATABASE.prepare("DELETE FROM cqu_bind_addresses WHERE user_id = 'u1'").run();
    if (status !== "missing") {
      await env.DATABASE.prepare("INSERT INTO cqu_bind_addresses (token,user_id,sender_whitelist,status) VALUES ('test-token','u1','[]',?)").bind(status).run();
    }
    const browser = spyBrowserFetch({ "/service-ticket": () => Response.json({ ok: true, ticket: "ST-must-not-mint" }) });
    for (const service of ["jwxt", "friends"]) {
      const ticket = await stub.fetch(`https://do/service-ticket?service=${service}`);
      expect(ticket.status).toBe(409);
      expect(await ticket.json()).toMatchObject({ code: "SESSION_INACTIVE" });
    }
    const harvest = await stub.fetch("https://do/data-harvest", { method: "POST", body: JSON.stringify({ navUrl: "https://my.cqu.edu.cn/", capture: [], fetch: [] }) });
    expect(harvest.ok).toBe(false);
    expect(browser).not.toHaveBeenCalled();
  });

  it("retries D1 credential deletion after DO cleanup without retaining the password", async () => {
    await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
    const stub = freshStub();
    await seedSession(stub);
    await seedCredentials(stub);
    await env.DATABASE.prepare("UPDATE cqu_bind_addresses SET status = 'deleting' WHERE user_id = 'u1'").run();
    const outage = vi.spyOn(env.DATABASE, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
    const failed = await stub.fetch("https://do/destroy", { method: "POST" });
    expect(failed.ok).toBe(false);
    outage.mockRestore();
    expect(await readStorage(stub, "credentials")).toBeUndefined();
    expect(await readStorage(stub, "bindingDeletion")).toBe("u1");
    await driveAlarm(stub);
    expect(await readStorage(stub, "bindingDeletion")).toBeUndefined();
    expect(await env.DATABASE.prepare("SELECT token FROM cqu_bind_addresses WHERE user_id = 'u1'").first()).toBeNull();
  });

  it("alarm removes orphaned encrypted credentials instead of keeping the school session alive", async () => {
    await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
    const stub = freshStub();
    await seedSession(stub);
    await seedCredentials(stub);
    await env.DATABASE.prepare("DELETE FROM cqu_credentials WHERE user_id = 'u1'").run();
    await env.DATABASE.prepare("DELETE FROM cqu_bind_addresses WHERE user_id = 'u1'").run();
    const browser = spyBrowserFetch({});
    await driveAlarm(stub);
    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage(stub, "credentials")).toBeUndefined();
    expect(await readStorage(stub, "state")).toBeUndefined();
    expect(await readStorage(stub, "status")).toBe("unbound");
  });
});
