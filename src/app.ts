import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { createAuth } from "./auth";
import { cqu } from "./routes/cqu";
import { cquBinding } from "./routes/cqu-bind";
import { cquQuicklogin } from "./routes/cqu-quicklogin";
import { admin } from "./routes/admin";
import type { HonoEnv } from "./types";
import { createV1Api } from "./api/v1";
import { createLegacyRouter } from "./api/legacy";
import { allowedMethods, listHttpOperations } from "./api/operations";
import { problem } from "./api/problem";
import { createAuthApi } from "./api/v1/auth";
import { AUTH_BASE_PATH } from "../shared/api-paths";
import { buildOpenApiDocument } from "./api/openapi/document";
import { getBetterAuthOpenApi, mergeBetterAuthOpenApi } from "./api/openapi/auth";

export function createApp() {
  const app = new Hono<HonoEnv>();

  const rejectWebSocketHead = async (c: Parameters<typeof problem>[0], next: () => Promise<void>) => {
    if (c.req.method !== "HEAD") return next();
    c.header("Allow", "GET, OPTIONS");
    return problem(c, "METHOD_NOT_ALLOWED", "WebSocket 握手不支持 HEAD", 405);
  };
  app.use("/api/cqu/binding/events", rejectWebSocketHead);
  app.use("/api/v1/cqu/binding/events", rejectWebSocketHead);

  app.use("/*", cors());

  app.route("/api/v1", createV1Api());
  app.route("/api", createLegacyRouter(async (request, pathname, env) => {
    const url = new URL(request.url);
    url.pathname = pathname;
    return app.request(new Request(url, request), undefined, env);
  }));

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

  app.get("/api/auth/registration-settings", async (c) => {
    const { isInvitationRequired } = await import("./services/entitlements");
    return c.json({ invitationRequired: await isInvitationRequired(c.env.DATABASE) });
  });

  app.route("/api/auth", createAuthApi({ legacy: true }));

  app.route("/api/cqu/binding", cquBinding);
  app.route("/api/cqu/quicklogin", cquQuicklogin);
  app.route("/api/cqu", cqu);
  app.route("/api/admin", admin);

  app.get("/api/v1/openapi.json", async (c) => {
    const base = buildOpenApiDocument(listHttpOperations(app));
    const authDocument = await getBetterAuthOpenApi(c.env, c.req.raw);
    return c.json(mergeBetterAuthOpenApi(base, authDocument));
  });

  const operations = listHttpOperations(app);
  const apiFallback = (c: Parameters<typeof problem>[0]) => {
    const allow = allowedMethods(operations, new URL(c.req.url).pathname);
    if (allow.length && !allow.includes(c.req.method)) {
      c.header("Allow", allow.join(", "));
      return problem(c, "METHOD_NOT_ALLOWED", "请求方法不受支持", 405);
    }
    return problem(c, "NOT_FOUND", "API 路径不存在", 404);
  };
  app.all("/api", apiFallback);
  app.all("/api/*", apiFallback);

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
