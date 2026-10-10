import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

type Session = { session: { id: string; impersonatedBy?: string }; user: { id: string; role: string } };

function absorbCookies(headers: Headers, response: Response) {
  const cookies = new Map((headers.get("cookie") ?? "").split("; ")
    .filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  for (const cookie of (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
    const pair = cookie.split(";")[0];
    const name = pair.slice(0, pair.indexOf("=")), value = pair.slice(pair.indexOf("=") + 1);
    if (!value) cookies.delete(name); else cookies.set(name, value);
  }
  headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
}

async function impersonation(api: Awaited<ReturnType<typeof createApiFixture>>) {
  const targetHeaders = await api.signIn("user");
  const target = await (await api.request("/api/v1/auth/get-session", { headers: targetHeaders })).json<Session>();
  const headers = await api.signIn("superAdmin");
  headers.set("origin", env.BETTER_AUTH_URL);
  headers.set("content-type", "application/json");
  const original = await (await api.request("/api/v1/auth/get-session", { headers })).json<Session>();
  const response = await api.request("/api/v1/auth/admin/impersonate-user", {
    method: "POST", headers, body: JSON.stringify({ userId: target.user.id }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  absorbCookies(headers, response);
  return { headers, original, target };
}

it("restores the original strong administrator session from ordinary-user impersonation without admitting other admin actions", async () => {
  const api = await createApiFixture();
  const { headers, original, target } = await impersonation(api);
  const impersonated = await (await api.request("/api/v1/auth/get-session", { headers })).json<Session>();
  expect(impersonated).toMatchObject({ user: { id: target.user.id, role: "user" }, session: { impersonatedBy: original.user.id } });
  expect((await api.request("/api/v1/auth/admin/list-users", { headers })).status).toBe(403);
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(403);
  const stopped = await api.request("/api/v1/auth/admin/stop-impersonating", { method: "POST", headers, body: "{}" });
  expect(stopped.status, await stopped.clone().text()).toBe(200);
  expect(await stopped.json()).toMatchObject({ user: { id: original.user.id }, session: { id: original.session.id } });
  absorbCookies(headers, stopped);
  expect(headers.get("cookie")).not.toContain("admin_session=");
  expect(await (await api.request("/api/v1/auth/get-session", { headers })).json()).toMatchObject({ user: { id: original.user.id }, session: { id: original.session.id } });
  expect((await api.request("/api/v1/auth/admin/list-users", { headers })).status).toBe(200);
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(200);
});

it("requires an impersonated session and its matching signed original-admin Cookie before restoring", async () => {
  const api = await createApiFixture();
  const first = await impersonation(api), other = await impersonation(api);
  const cookies = first.headers.get("cookie")!.split("; ");
  const originalCookie = cookies.find(cookie => cookie.split("=")[0].endsWith(".admin_session"))!;
  const otherCookie = other.headers.get("cookie")!.split("; ").find(cookie => cookie.split("=")[0].endsWith(".admin_session"))!;
  expect(originalCookie).toBeDefined();
  expect(otherCookie).toBeDefined();
  const stop = (headers: Headers) => api.request("/api/v1/auth/admin/stop-impersonating", { method: "POST", headers, body: "{}" });
  for (const replacement of [null, `${originalCookie.split("=")[0]}=invalid-signature`, otherCookie]) {
    const headers = new Headers(first.headers);
    headers.set("cookie", [...cookies.filter(cookie => cookie !== originalCookie), ...(replacement ? [replacement] : [])].join("; "));
    const denied = await stop(headers);
    expect(denied.status, await denied.clone().text()).toBe(500);
    expect(await denied.json()).toMatchObject({ message: "Failed to find admin session" });
    expect(await (await api.request("/api/v1/auth/get-session", { headers })).json()).toMatchObject({ user: { id: first.target.user.id }, session: { impersonatedBy: first.original.user.id } });
    expect(denied.headers.get("set-cookie") ?? "").not.toContain("session_token=");
  }
  const ordinary = await api.signIn("user");
  ordinary.set("origin", env.BETTER_AUTH_URL); ordinary.set("content-type", "application/json");
  ordinary.set("cookie", `${ordinary.get("cookie")}; ${originalCookie}`);
  const notImpersonating = await stop(ordinary);
  expect(notImpersonating.status).toBe(400);
  expect(await notImpersonating.json()).toMatchObject({ message: "You are not impersonating anyone" });
  expect((await stop(new Headers({ origin: env.BETTER_AUTH_URL, "content-type": "application/json" }))).status).toBe(401);
  const restored = await stop(first.headers);
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ user: { id: first.original.user.id }, session: { id: first.original.session.id } });
});
