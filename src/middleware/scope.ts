import type { Context, Next } from "hono";
import type { HonoEnv } from "../types";
import { oauthClientCquScopes } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { errorResponse } from "../utils/error";
import { scopeSatisfies } from "../services/oauth-scopes";

export function requireCquScope(service: string) {
  return async (c: Context<HonoEnv>, next: Next) => {
    const rejected = await cquScopeRejection(c, service);
    if (rejected) return rejected;
    return next();
  };
}

export async function cquScopeRejection(
  c: Context<HonoEnv>,
  service: string
): Promise<Response | null> {
    const principal = c.get("principal");
    if (!principal || principal.kind !== "bearer") {
      return errorResponse(c, "UNAUTHORIZED", "取票需要 Bearer 访问令牌", 401);
    }

    if (service === "*") return null;

    const requiredScope = `cqu:ticket:${service}`;
    if (!scopeSatisfies(principal.scopes, requiredScope)) {
      return errorResponse(c, "FORBIDDEN", `缺少所需的 scope: ${requiredScope}`, 403);
    }

    const db = drizzle(c.env.DATABASE);
    const rows = await db
      .select()
      .from(oauthClientCquScopes)
      .where(eq(oauthClientCquScopes.clientId, principal.clientId))
      .all();
    if (!scopeSatisfies(rows.map((row) => row.scope), requiredScope)) {
      return errorResponse(c, "FORBIDDEN", "该应用未被授权访问此 CQU 服务", 403);
    }

    return null;
}
