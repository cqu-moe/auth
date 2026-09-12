import { API_BASE_PATH } from "../../../../shared/api-paths";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiUrl(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new TypeError("API path must be a same-origin absolute path");
  }
  return `${API_BASE_PATH}${path}`;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      const body = await response.json().catch(() => null) as {
        status?: number; code?: string; detail?: string;
      } | null;
      if (body && typeof body.code === "string" && typeof body.detail === "string") {
        throw new ApiError(response.status, body.code, body.detail, body);
      }
    }
    throw new ApiError(response.status, "UPSTREAM_ERROR", "请求失败，请稍后重试");
  }
  return response.json() as Promise<T>;
}
