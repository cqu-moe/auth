export type LegacyEvent = "api.legacy_rejected";

export function logLegacy(event: LegacyEvent, method: string, route: string, status: number) {
  console.info(JSON.stringify({ event, method, route, status }));
}

export function rejectedLegacyCategory(pathname: string): string | null {
  if (pathname.startsWith("/api/cqu/quicklogin/devices")) {
    return "/api/cqu/quicklogin/devices/*";
  }
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) {
    return "/api/health";
  }
  for (const prefix of ["auth", "cqu", "admin"] as const) {
    if (pathname === `/api/${prefix}` || pathname.startsWith(`/api/${prefix}/`)) {
      return `/api/${prefix}/*`;
    }
  }
  return null;
}
