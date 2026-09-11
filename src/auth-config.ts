import { AUTH_BASE_PATH } from "../shared/api-paths";

export function authUrls(origin: string) {
  const normalizedOrigin = new URL(origin).origin;
  return {
    basePath: AUTH_BASE_PATH,
    issuer: `${normalizedOrigin}/api/auth`,
    jwksUrl: `${normalizedOrigin}${AUTH_BASE_PATH}/jwks`,
  } as const;
}
