import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";

const app = new Hono<HonoEnv>();

app.use("/*", cors());

app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

export default app;
