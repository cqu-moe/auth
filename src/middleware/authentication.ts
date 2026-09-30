import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessToken } from "better-auth/oauth2";
import { createAuth } from "../auth";
import { problem } from "../api/problem";
import type { HonoEnv, Principal, RequestAuthCache } from "../types";
import { authUrls } from "../auth-config";

function getCache(c: Context<HonoEnv>): RequestAuthCache {
  let cache = c.get("requestAuthCache");
  if (!cache) {
    cache = {};
    c.set("requestAuthCache", cache);
  }
  return cache;
}

function exposePrincipal(c: Context<HonoEnv>, principal: Principal) {
  c.set("principal", principal);
  if (principal.kind === "session") {
    c.set("user", principal.user);
    c.set("clientId", undefined);
  } else {
    c.set("user", { id: principal.userId });
    c.set("clientId", principal.clientId);
  }
}

async function sessionPrincipal(c: Context<HonoEnv>): Promise<Principal | null> {
  const cache = getCache(c);
  cache.session ??= (async () => {
    const auth = createAuth(c.env, c.req.raw);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user || typeof session.user.id !== "string" || !session.user.id) return null;
    return { kind: "session", user: session.user } satisfies Principal;
  })();
  return cache.session;
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function claimScopes(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  return value.split(/\s+/).filter(Boolean);
}

async function bearerPrincipal(c: Context<HonoEnv>): Promise<Principal | null> {
  const cache = getCache(c);
  cache.bearer ??= (async () => {
    const authorization = c.req.header("Authorization");
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice(7);
    if (!token) return null;

    try {
      const { issuer, jwksUrl } = authUrls(c.env.BETTER_AUTH_URL);
      const payload = await verifyAccessToken(token, {
        verifyOptions: { issuer, audience: issuer },
        jwksUrl,
      });
      const userId = claimString(payload.sub);
      const clientId = claimString(payload.azp ?? payload.client_id);
      const scopes = claimScopes(payload.scope);
      if (!userId || !clientId || !scopes) return null;
      return { kind: "bearer", userId, clientId, scopes } satisfies Principal;
    } catch {
      return null;
    }
  })();
  return cache.bearer;
}

function requirePrincipal(
  resolve: (c: Context<HonoEnv>) => Promise<Principal | null>,
  detail: string
): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const principal = await resolve(c);
    if (!principal) return problem(c, "UNAUTHORIZED", detail, 401);
    exposePrincipal(c, principal);
    return next();
  };
}

export const requireSession = requirePrincipal(sessionPrincipal, "未登录");
export const requireBearer = requirePrincipal(bearerPrincipal, "无效的访问令牌");

export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const principal = await sessionPrincipal(c);
  if (!principal || principal.kind !== "session") {
    return problem(c, "UNAUTHORIZED", "未登录", 401);
  }
  const role = principal.user.role;
  if (role !== "admin" && role !== "superAdmin") {
    return problem(c, "FORBIDDEN", "需要管理员权限", 403);
  }
  exposePrincipal(c, principal);
  return next();
};
