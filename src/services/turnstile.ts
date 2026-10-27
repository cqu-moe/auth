import type { Env } from "../types";
import type { TurnstileAction } from "../../shared/turnstile";
import { inArray, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { turnstileRedemption } from "../db/schema";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 10_000;
const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type TurnstileVerification =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 503;
      code: "TURNSTILE_REQUIRED" | "TURNSTILE_FAILED" | "TURNSTILE_UNAVAILABLE";
      message: string;
    };

function unavailable(): TurnstileVerification {
  return {
    ok: false,
    status: 503,
    code: "TURNSTILE_UNAVAILABLE",
    message: "安全验证服务暂不可用，请稍后重试",
  };
}

function failed(): TurnstileVerification {
  return {
    ok: false,
    status: 403,
    code: "TURNSTILE_FAILED",
    message: "安全验证未通过，请重新验证后再提交",
  };
}

interface SiteverifyResponse {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
}

export async function verifyTurnstileToken(
  env: Env,
  token: string | undefined,
  action: TurnstileAction
): Promise<TurnstileVerification> {
  const providedToken = token?.trim() ?? "";
  if (!providedToken) {
    return {
      ok: false,
      status: 403,
      code: "TURNSTILE_REQUIRED",
      message: "请完成安全验证后重试",
    };
  }
  if (providedToken.length > 2_048) return failed();

  const secret = env.TURNSTILE_SECRET?.trim();
  if (!secret) return unavailable();
  if (env.ENVIRONMENT === "production" && TEST_SECRETS.has(secret)) {
    return unavailable();
  }

  let expectedHostname: string;
  try {
    expectedHostname = new URL(env.BETTER_AUTH_URL).hostname;
    if (env.ENVIRONMENT === "production" && LOCAL_HOSTNAMES.has(expectedHostname)) {
      return unavailable();
    }
  } catch {
    return unavailable();
  }

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: providedToken }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch {
    return unavailable();
  }

  if (!response.ok) return unavailable();

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return unavailable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return unavailable();
  }
  const payload = parsed as SiteverifyResponse;

  if (payload.success !== true) return failed();
  if (payload.action !== action) return failed();
  if (payload.hostname !== expectedHostname) return failed();

  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(providedToken));
    const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const now = Date.now();
    const db = drizzle(env.DATABASE);
    // Siteverify can accept replays; D1 must atomically admit only one request.
    const [, redeemed] = await db.batch([
      db.delete(turnstileRedemption).where(inArray(
        turnstileRedemption.tokenHash,
        db.select({ tokenHash: turnstileRedemption.tokenHash }).from(turnstileRedemption)
          .where(lte(turnstileRedemption.expiresAt, now)).limit(100)
      )),
      db.insert(turnstileRedemption).values({ tokenHash, expiresAt: now + 300_000 })
        .onConflictDoNothing().returning({ tokenHash: turnstileRedemption.tokenHash }),
    ]);
    if (redeemed.length === 0) return failed();
  } catch {
    return unavailable();
  }
  return { ok: true };
}
