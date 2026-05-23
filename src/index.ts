import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";
import { createAuth } from "./auth";

const app = new Hono<HonoEnv>();

app.use("/*", cors());

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

export default app;
