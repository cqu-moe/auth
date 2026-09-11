import { Hono } from "hono";
import { admin as legacyAdmin } from "../../../routes/admin";
import type { HonoEnv } from "../../../types";
import { problem } from "../../problem";

async function forward(c: Parameters<typeof problem>[0], pathname: string) {
  const url = new URL(c.req.url);
  url.pathname = pathname;
  return legacyAdmin.request(new Request(url, c.req.raw), undefined, c.env);
}

async function json(c: Parameters<typeof problem>[0], response: Response) {
  const body = await response.json() as Record<string, any>;
  if (!response.ok) {
    if (typeof body.status === "number" && typeof body.code === "string") {
      return { error: new Response(JSON.stringify(body), response), body };
    }
    const legacy = body.detail?.error;
    return {
      error: problem(c, legacy?.code ?? "INTERNAL_ERROR", legacy?.message ?? "OAuth 客户端操作失败", response.status),
      body,
    };
  }
  return { body };
}

export function createAdminOAuthClientsApi() {
  const api = new Hono<HonoEnv>();

  api.get("/", async (c) => {
    const result = await json(c, await forward(c, "/oauth-clients"));
    if (result.error) return result.error;
    const data = (result.body.data as Array<Record<string, unknown>>).map((client) => {
      const { id: _id, clientId: _clientId, name: _name, ...view } = client;
      return view;
    });
    return c.json({ data });
  });

  api.post("/", async (c) => {
    const result = await json(c, await forward(c, "/oauth-clients"));
    if (result.error) return result.error;
    c.header("Cache-Control", "no-store");
    return c.json({ data: result.body.data }, 201);
  });

  api.patch("/:id", async (c) => {
    const path = `/oauth-clients/${encodeURIComponent(c.req.param("id"))}`;
    const result = await json(c, await forward(c, path));
    if (result.error) return result.error;
    if (result.body.data?.client_secret) c.header("Cache-Control", "no-store");
    return c.json({ data: result.body.data ?? { client_id: c.req.param("id") } });
  });

  api.delete("/:id", async (c) => {
    const path = `/oauth-clients/${encodeURIComponent(c.req.param("id"))}`;
    const result = await json(c, await forward(c, path));
    if (result.error) return result.error;
    return c.body(null, 204);
  });

  api.get("/:id/scopes", async (c) => {
    const path = `/oauth-clients/${encodeURIComponent(c.req.param("id"))}/scopes`;
    const result = await json(c, await forward(c, path));
    if (result.error) return result.error;
    return c.json({ data: { client_id: result.body.clientId, scopes: result.body.scopes } });
  });

  api.put("/:id/scopes", async (c) => {
    const path = `/oauth-clients/${encodeURIComponent(c.req.param("id"))}/scopes`;
    const result = await json(c, await forward(c, path));
    if (result.error) return result.error;
    return c.json({ data: { client_id: result.body.clientId, scopes: result.body.scopes } });
  });

  api.post("/:id/secrets", async (c) => {
    const path = `/oauth-clients/${encodeURIComponent(c.req.param("id"))}/rotate-secret`;
    const result = await json(c, await forward(c, path));
    if (result.error) return result.error;
    c.header("Cache-Control", "no-store");
    return c.json({ data: result.body.data }, 201);
  });

  return api;
}
