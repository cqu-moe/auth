import { afterEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "./admin";

afterEach(() => vi.unstubAllGlobals());

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
});
