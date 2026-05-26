import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";
import { createAuth } from "./auth";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { cqu } from "./routes/cqu";
import { admin } from "./routes/admin";

const app = new Hono<HonoEnv>();

app.use("/*", cors());

app.get("/api/health", (c) =>
  c.json({ status: "ok", version: "d1native-fix", timestamp: new Date().toISOString() })
);

app.get("/.well-known/oauth-authorization-server", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return oauthProviderAuthServerMetadata(auth)(c.req.raw);
});

app.get("/.well-known/openid-configuration", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return oauthProviderOpenIdConfigMetadata(auth)(c.req.raw);
});

app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

app.route("/api/cqu", cqu);
app.route("/api/admin", admin);

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
export { CquSessionDO } from "./durable-objects/cqu-session";
