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
import { postHogCookieResetResponse } from "./lib/posthog-cookie";

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
    if (path.startsWith("/api/v1/cqu/quicklogin/devices")) {
      return next();
    }
    const origin = c.req.header("origin");
    if (origin) {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Vary", "Origin");
    }
    if (c.req.method !== "OPTIONS") return next();
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

  app.get("/api/v1/telemetry/reset", (c) =>
    postHogCookieResetResponse(c.env.POSTHOG_PROJECT_TOKEN));
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

  app.get("/api/v1/openapi.json", async (c) => {
    const base = buildOpenApiDocument(listHttpOperations(app));
    const authDocument = await getBetterAuthOpenApi(c.env, c.req.raw);
    return c.json(mergeBetterAuthOpenApi(base, authDocument));
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

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
