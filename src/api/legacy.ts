import { Hono, type Context } from "hono";
import type { HonoEnv } from "../types";

export type ForwardToV1 = (
  request: Request,
  pathname: string,
  env: HonoEnv["Bindings"]
) => Promise<Response>;

export type LegacyEvent = "api.legacy_bridge" | "api.legacy_rejected";

export function logLegacy(event: LegacyEvent, method: string, route: string, status: number) {
  console.info(JSON.stringify({ event, method, route, status }));
}

export function rejectedLegacyCategory(pathname: string): string | null {
  if (pathname.startsWith("/api/cqu/quicklogin/devices")) {
    return "/api/cqu/quicklogin/devices/*";
  }
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) {
    return "/api/health";
  }
  for (const prefix of ["auth", "cqu", "admin"] as const) {
    if (pathname === `/api/${prefix}` || pathname.startsWith(`/api/${prefix}/`)) {
      return `/api/${prefix}/*`;
    }
  }
  return null;
}

export function createLegacyRouter(forwardToV1: ForwardToV1) {
  const legacy = new Hono<HonoEnv>();
  const forward = (template: string) => async (c: Context<HonoEnv>) => {
    const url = new URL(c.req.url);
    url.pathname = `/api/v1${url.pathname.slice("/api".length)}`;
    const response = await forwardToV1(c.req.raw, url.pathname, c.env);
    logLegacy("api.legacy_bridge", c.req.method, template, response.status);
    return response;
  };

  legacy.get("/auth/oauth2/authorize", forward("/api/auth/oauth2/authorize"));
  legacy.post("/auth/oauth2/token", forward("/api/auth/oauth2/token"));
  legacy.get("/auth/reset-password/:token", forward("/api/auth/reset-password/:token"));

  const deviceRoutes = [
    ["GET", "/cqu/quicklogin/devices", "/api/cqu/quicklogin/devices"],
    ["POST", "/cqu/quicklogin/devices", "/api/cqu/quicklogin/devices"],
    ["PUT", "/cqu/quicklogin/devices/:id", "/api/cqu/quicklogin/devices/:id"],
    ["DELETE", "/cqu/quicklogin/devices/:id", "/api/cqu/quicklogin/devices/:id"],
    ["POST", "/cqu/quicklogin/devices/:id/status", "/api/cqu/quicklogin/devices/:id/status"],
    ["POST", "/cqu/quicklogin/devices/:id/refresh", "/api/cqu/quicklogin/devices/:id/refresh"],
    ["POST", "/cqu/quicklogin/devices/:id/export", "/api/cqu/quicklogin/devices/:id/export"],
    ["OPTIONS", "/cqu/quicklogin/devices", "/api/cqu/quicklogin/devices"],
    ["OPTIONS", "/cqu/quicklogin/devices/:id", "/api/cqu/quicklogin/devices/:id"],
    ["OPTIONS", "/cqu/quicklogin/devices/:id/status", "/api/cqu/quicklogin/devices/:id/status"],
    ["OPTIONS", "/cqu/quicklogin/devices/:id/refresh", "/api/cqu/quicklogin/devices/:id/refresh"],
    ["OPTIONS", "/cqu/quicklogin/devices/:id/export", "/api/cqu/quicklogin/devices/:id/export"],
  ] as const;
  for (const [method, path, template] of deviceRoutes) {
    legacy.on(method, path, forward(template));
  }
  return legacy;
}
