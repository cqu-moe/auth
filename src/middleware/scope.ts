import type { Context, Next } from "hono";
import type { Env } from "../types";
import { verifyAccessToken } from "better-auth/oauth2";
import { oauthClientCquScopes } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { errorResponse } from "../utils/error";

export function requireCquScope(service: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.substring(7);

    let payload;
    try {
      payload = await verifyAccessToken(token, {
        verifyOptions: {
          issuer: c.env.BETTER_AUTH_URL,
          audience: c.env.BETTER_AUTH_URL,
        },
        jwksUrl: `${c.env.BETTER_AUTH_URL}/api/auth/jwks`,
      });
    } catch {
      return errorResponse(c, "UNAUTHORIZED", "无效的访问令牌", 401);
    }

    if (service === "*") {
      return next();
    }

    const grantedScopes = (payload.scope as string)?.split(" ") ?? [];
    const requiredScope = `cqu:ticket:${service}`;
    const hasTokenScope =
      grantedScopes.includes(requiredScope) ||
      grantedScopes.includes("cqu:ticket:*");

    if (!hasTokenScope) {
      return errorResponse(c, "FORBIDDEN", `缺少所需的 scope: ${requiredScope}`, 403);
    }

    const clientId = (payload.azp ?? payload.client_id) as string | undefined;
    if (clientId) {
      const db = drizzle(c.env.DATABASE);
      const rows = await db
        .select()
        .from(oauthClientCquScopes)
        .where(eq(oauthClientCquScopes.clientId, clientId))
        .all();
      const clientScopes = rows.map((r) => r.scope);
      if (
        !clientScopes.includes(requiredScope) &&
        !clientScopes.includes("cqu:ticket:*")
      ) {
        return errorResponse(c, "FORBIDDEN", "该应用未被授权访问此 CQU 服务", 403);
      }
    }

    return next();
  };
}
