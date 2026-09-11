import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "./http";

afterEach(() => vi.unstubAllGlobals());

describe("API client", () => {
  it("prefixes safe paths, includes credentials, and handles 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest<void>("/admin/items/1", { method: "DELETE" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/items/1", expect.objectContaining({
      method: "DELETE", credentials: "include",
    }));
  });

  it("turns Problem Details and upstream HTML into safe errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      type: "about:blank", title: "Bad Request", status: 400, detail: "请求体无效", code: "INVALID_BODY",
    }), { status: 400, headers: { "content-type": "application/problem+json" } }))
      .mockResolvedValueOnce(new Response("<script>secret()</script>", {
        status: 502, headers: { "content-type": "text/html" },
      })));
    await expect(apiRequest("/failure")).rejects.toMatchObject({ status: 400, code: "INVALID_BODY" });
    await expect(apiRequest("/failure")).rejects.toEqual(new ApiError(502, "UPSTREAM_ERROR", "请求失败，请稍后重试"));
  });

  it("rejects absolute paths and preserves AbortError", async () => {
    await expect(apiRequest("https://evil.test/data")).rejects.toThrow("API path");
    await expect(apiRequest("//evil.test/data")).rejects.toThrow("API path");
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(apiRequest("/slow")).rejects.toBe(abort);
  });
});
