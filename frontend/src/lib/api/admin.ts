function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

export async function adminFetch(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/admin/") && path !== "/admin") {
    throw new TypeError("Admin API path must stay under /admin");
  }
  let canonicalPath = path;
  let method = init.method ?? "GET";
  let body = init.body;
  let legacyAction: string | undefined;

  if (method === "PATCH" && /^\/admin\/users\/[^/]+$/.test(path) && typeof body === "string") {
    const input = JSON.parse(body) as { action?: string; role?: string };
    legacyAction = input.action;
    if (input.action === "ban" || input.action === "unban") {
      body = JSON.stringify({ banned: input.action === "ban" });
    }
  }
  if (path.endsWith("/entitlements/preset")) {
    canonicalPath = path.slice(0, -"/preset".length);
    method = "PATCH";
  }
  if (path.endsWith("/rotate-secret")) {
    canonicalPath = `${path.slice(0, -"/rotate-secret".length)}/secrets`;
  }

  const response = await fetch(`/api/v1${canonicalPath}`, {
    ...init,
    method,
    body,
    credentials: "include",
  });
  if (response.status === 204) return jsonResponse({ success: true });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return response;
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    if (typeof payload.detail === "string") {
      return jsonResponse({ detail: { error: { code: payload.code, message: payload.detail } } }, response.status);
    }
    return jsonResponse(payload, response.status);
  }
  if (legacyAction) {
    return jsonResponse({ success: true, action: legacyAction === "ban" ? "banned" : "unbanned" });
  }
  if (path === "/admin/oauth-clients" && method === "GET" && Array.isArray(payload.data)) {
    return jsonResponse({ data: payload.data.map((value: unknown) => {
      const client = value as Record<string, unknown>;
      return {
        ...client,
        id: client.client_id,
        clientId: client.client_id,
        name: client.client_name ?? client.client_id,
      };
    }) });
  }
  if (path.endsWith("/scopes") && payload.data) {
    const data = payload.data as { client_id: string; scopes: string[] };
    return jsonResponse({
      ...(method === "PUT" ? { success: true } : {}),
      clientId: data.client_id,
      scopes: data.scopes,
    });
  }
  if (path === "/admin/registration-settings" && method === "GET") return jsonResponse(payload.data);
  if (path === "/admin/entitlement-default" && method === "GET") return jsonResponse(payload.data);
  return jsonResponse(payload, response.status, response.headers);
}
