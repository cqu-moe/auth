import type { Context, Next } from "hono";
import type { HonoEnv } from "../types";
import { verifyAuthAccessToken } from "../services/auth-access-token";
import { oauthClientCquScopes } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { errorResponse } from "../utils/error";

// 一组 scope 是否满足某个所需 cqu ticket scope。
// cqu:ticket:* 是通配,满足任何 required(含 any 与符号 key);
// 否则必须精确含有 required。注意:cqu:ticket:any 不授予符号 key(最小权限),
// 反之亦然 —— 它们是各自独立的 required 值,只有 * 跨越两者。
export function scopeSatisfies(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes("cqu:ticket:*");
}

export function requireCquScope(service: string) {
  return async (c: Context<HonoEnv>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      // 取 CQU 票必须凭带 cqu:ticket:* scope 的 Bearer 访问令牌 + 客户端授权。
      // 仅 cookie 的调用方一律拒绝(避免任意登录会话零授权铸符号票);
      // 第一方子系统的 cookie/离线取票走 RPC 路径(C2),不走此公共路由。
      return errorResponse(c, "UNAUTHORIZED", "取票需要 Bearer 访问令牌", 401);
    }

    const token = authHeader.substring(7);

    let payload;
    try {
      payload = await verifyAuthAccessToken(token, c.env);
    } catch {
      return errorResponse(c, "UNAUTHORIZED", "无效的访问令牌", 401);
    }

    if (service === "*") {
      return next();
    }

    const grantedScopes = (payload.scope as string)?.split(" ") ?? [];
    const requiredScope = `cqu:ticket:${service}`;

    if (!scopeSatisfies(grantedScopes, requiredScope)) {
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
      if (!scopeSatisfies(clientScopes, requiredScope)) {
        return errorResponse(c, "FORBIDDEN", "该应用未被授权访问此 CQU 服务", 403);
      }
    }

    return next();
  };
}
