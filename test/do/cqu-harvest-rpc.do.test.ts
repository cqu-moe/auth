import { describe, expect, it } from "vitest";
import { AuthService } from "../../src/rpc";

describe("harvest RPC error boundary", () => {
  it.each([
    "WAF_BOOTSTRAP_TIMEOUT", "APP_READY_TIMEOUT", "TABLE_CAPTURE_TIMEOUT",
    "TABLE_REQUEST_HUNG", "TABLE_BODY_TIMEOUT", "TABLE_API_REJECTED",
    "WAF_CHALLENGE", "SCHEDULE_NOT_PUBLISHED", "HARVEST_TRANSIENT",
    "TGT_EXPIRED", "BROWSER_INSTANCE_REPLACED",
  ])("returns only the DO code %s", async (code) => {
    // Authentication and the DO binding are external to this RPC response boundary.
    const target = {
      authenticateClient: async () => true,
      env: { CQU_SESSION: {
        idFromName: () => "test-id",
        get: () => ({ fetch: async () => Response.json({
          code, error: "SECRET raw error", diagnostics: { secret: "SECRET" },
          state: { secret: "SECRET" },
        }, { status: 503 }) }),
      } },
    } as unknown as AuthService;
    expect(await AuthService.prototype.cquHarvest.call(target, {
      clientId: "test-client", clientSecret: "test-secret", userId: "test-user",
      navUrl: "https://my.cqu.edu.cn/workspace/curriculum",
    })).toEqual({ error: code });
  });
});
