import { Hono } from "hono";
import type { HonoEnv } from "../types";

export type ForwardToV1 = (
  request: Request,
  pathname: string,
  env: HonoEnv["Bindings"]
) => Promise<Response>;

export function createLegacyRouter(forwardToV1: ForwardToV1) {
  const legacy = new Hono<HonoEnv>();

  legacy.get("/health", async (c) => {
    const response = await forwardToV1(c.req.raw, "/api/v1/health", c.env);
    const body = response.body;
    if (!response.ok) return new Response(body, response);
    const canonical = await response.json<{ data: { status: "ok"; timestamp: string } }>();
    return c.json({
      ...canonical.data,
      version: "d1native-fix",
    });
  });

  return legacy;
}
