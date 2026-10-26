import { Hono } from "hono";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { createAuth } from "./auth";
import type { HonoEnv } from "./types";
import { createV1Api } from "./api/v1";
import { logLegacy, rejectedLegacyCategory } from "./api/legacy";
import { allowedMethods, listHttpOperations } from "./api/operations";
import { problem } from "./api/problem";
import { createAuthApi } from "./api/v1/auth";
import { AUTH_BASE_PATH } from "../shared/api-paths";
import { buildOpenApiDocument } from "./api/openapi/document";
import { getBetterAuthOpenApi, mergeBetterAuthOpenApi } from "./api/openapi/auth";
import { captureHonoException } from "./lib/posthog";
import { acceptedQuickloginOrigin } from "./services/quicklogin/extension-origin";

export function createApp() {
  const app = new Hono<HonoEnv>();
  app.onError((error, c) => {
    captureHonoException(error, c);
    return problem(c, "INTERNAL_ERROR", "服务器内部错误", 500);
  });
  let runtimeOperations: ReturnType<typeof listHttpOperations> = [];

  const rejectWebSocketHead = async (c: Parameters<typeof problem>[0], next: () => Promise<void>) => {
    if (c.req.method !== "HEAD") return next();
    c.header("Allow", "GET, OPTIONS");
    return problem(c, "METHOD_NOT_ALLOWED", "WebSocket 握手不支持 HEAD", 405);
  };
  app.use("/api/v1/cqu/binding/events", rejectWebSocketHead);

  app.use("/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/v1/cqu/quicklogin/devices") ||
      /^\/api\/v1\/cqu\/quicklogin\/(capabilities|registrations|overview)\/?$/.test(path)) {
      return next();
    }
    const origin = c.req.header("origin");
    const websiteStatus = origin === "https://quicklogin.cqu.moe" &&
      /^\/api\/v1\/cqu\/quicklogin\/?$/.test(path) &&
      (["GET", "HEAD"].includes(c.req.method) || (c.req.method === "OPTIONS" && c.req.header("access-control-request-method") === "GET"));
    const extensionTokenOrigin = path === "/api/v1/auth/oauth2/token"
      ? acceptedQuickloginOrigin(c.env, origin) : null;
    if (origin) {
      c.header("Access-Control-Allow-Origin", extensionTokenOrigin ?? (websiteStatus ? origin : "*"));
      if (websiteStatus) c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
    if (c.req.method !== "OPTIONS") {
      await next();
      // Native token responses replace headers set before next(). Restore only
      // a configured extension's public-client token CORS, without credentials.
      if (origin && acceptedQuickloginOrigin(c.env, origin) && c.req.method === "POST" && path === "/api/v1/auth/oauth2/token") {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Vary", "Origin", { append: true });
      }
      if (websiteStatus) {
        c.header("Access-Control-Allow-Origin", origin!);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Vary", "Origin", { append: true });
      }
      return;
    }
    const methods = allowedMethods(runtimeOperations, path)
      .filter((method) => method !== "OPTIONS");
    const requested = c.req.header("access-control-request-method")?.toUpperCase();
    if (!methods.length || (requested && !methods.includes(requested))) return next();
    c.header("Access-Control-Allow-Methods", methods.join(", "));
    const requestedHeaders = c.req.header("access-control-request-headers");
    if (requestedHeaders) c.header("Access-Control-Allow-Headers", requestedHeaders);
    return c.body(null, 204);
  });

  app.use("/api/v1/admin/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.route("/api/v1", createV1Api());

  const oauthMetadata = async (c: Parameters<typeof problem>[0]) => {
    const auth = createAuth(c.env, c.req.raw);
    return oauthProviderAuthServerMetadata(auth)(c.req.raw);
  };

  const openIdMetadata = async (c: Parameters<typeof problem>[0]) => {
    const auth = createAuth(c.env, c.req.raw);
    return oauthProviderOpenIdConfigMetadata(auth)(c.req.raw);
  };

  app.get("/.well-known/oauth-authorization-server", oauthMetadata);
  app.get("/.well-known/openid-configuration", openIdMetadata);
  app.get("/api/auth/.well-known/openid-configuration", openIdMetadata);
  app.get("/api/auth/.well-known/oauth-authorization-server", oauthMetadata);
  app.get("/.well-known/oauth-authorization-server/api/auth", oauthMetadata);

  app.route(AUTH_BASE_PATH, createAuthApi());

  // ponytail: isolate 级按 BETTER_AUTH_URL memoize —— 文档只随部署（路由树 + baseURL）变化。
  // 并发冷启动会重复构建（幂等，无锁）；若文档需按请求变化，改伺服静态产物。
  let openApiCache: { url: string; body: string } | undefined;
  app.get("/api/v1/openapi.json", async (c) => {
    const url = c.env.BETTER_AUTH_URL;
    if (openApiCache?.url !== url) {
      const base = buildOpenApiDocument(listHttpOperations(app));
      const authDocument = await getBetterAuthOpenApi(c.env, c.req.raw);
      openApiCache = { url, body: JSON.stringify(mergeBetterAuthOpenApi(base, authDocument)) };
    }
    c.header("Cache-Control", "public, max-age=300");
    c.header("Content-Type", "application/json");
    return c.body(openApiCache.body);
  });

  const operations = listHttpOperations(app);
  runtimeOperations = operations;
  const apiFallback = (c: Parameters<typeof problem>[0]) => {
    const pathname = new URL(c.req.url).pathname;
    const allow = allowedMethods(operations, pathname);
    if (allow.length && !allow.includes(c.req.method)) {
      c.header("Allow", allow.join(", "));
      const response = problem(c, "METHOD_NOT_ALLOWED", "请求方法不受支持", 405);
      const category = rejectedLegacyCategory(pathname);
      if (category) logLegacy("api.legacy_rejected", c.req.method, category, 405);
      return response;
    }
    const response = problem(c, "NOT_FOUND", "API 路径不存在", 404);
    const category = rejectedLegacyCategory(pathname);
    if (category) logLegacy("api.legacy_rejected", c.req.method, category, 404);
    return response;
  };
  app.all("/api", apiFallback);
  app.all("/api/*", apiFallback);

  app.all("*", async (c) => {
    c.res = await c.env.ASSETS.fetch(c.req.raw);
    c.header("Content-Security-Policy", "frame-ancestors 'none'", { append: true });
    c.header("X-Frame-Options", "DENY");
    return c.res;
  });

  return app;
}
