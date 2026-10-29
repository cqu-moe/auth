import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "./admin";
import { requestAuthentication } from "../recent-authentication";

vi.mock("../recent-authentication", () => ({ requestAuthentication: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.mocked(requestAuthentication).mockReset());

describe("admin v1 transport", () => {
  it("maps legacy UI actions to canonical resource changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { id: "u1", banned: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await adminFetch("/admin/users/u1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "ban" }),
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/users/u1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ banned: true }), credentials: "include",
    }));
    expect(await response.json()).toEqual({ success: true, action: "banned" });
  });

  it("maps preset merge and secret rotation without retrying writes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { applied: 2 } }))
      .mockResolvedValueOnce(Response.json({ data: { client_id: "c1", client_secret: "once" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await adminFetch("/admin/users/u1/entitlements/preset", {
      method: "POST", body: JSON.stringify({ preset: "学生" }),
    });
    await adminFetch("/admin/oauth-clients/c1/rotate-secret", { method: "POST" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/users/u1/entitlements");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/admin/oauth-clients/c1/secrets");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reauthenticates and retries a rejected secret rotation once with the same request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: "RECENT_AUTH_REQUIRED", detail: "请重新验证身份后继续" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ data: { client_id: "c1", client_secret: "once" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(requestAuthentication).mockResolvedValue(true);
    const response = await adminFetch("/admin/oauth-clients/c1/rotate-secret", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(requestAuthentication).toHaveBeenCalledExactlyOnceWith("admin");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    expect(await response.json()).toEqual({ data: { client_id: "c1", client_secret: "once" } });
  });

  it.each([false, true])("does not loop on declined or ineffective reauthentication (verified=%s)", async (verified) => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({
      code: "RECENT_AUTH_REQUIRED", detail: "请重新验证身份后继续",
    }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(requestAuthentication).mockResolvedValue(verified);
    const response = await adminFetch("/admin/users/u1", { method: "PATCH", body: JSON.stringify({ role: "admin" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ detail: { error: { code: "RECENT_AUTH_REQUIRED" } } });
    expect(fetchMock).toHaveBeenCalledTimes(verified ? 2 : 1);
    expect(requestAuthentication).toHaveBeenCalledTimes(1);
  });

  it("does not retry permission failures or request presence for reads", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ code: "FORBIDDEN", detail: "需要权益写权限" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await adminFetch("/admin/entitlement-default", { method: "PUT", body: JSON.stringify({ preset: null }) });
    await adminFetch("/admin/users");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAuthentication).not.toHaveBeenCalled();
  });
});
