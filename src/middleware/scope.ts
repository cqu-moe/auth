import type { Context, Next } from "hono";
import type { Env } from "../types";

// Validates that the requesting OAuth client has the required cqu:ticket:<service> scope.
// If request uses session cookie (direct user access), the scope check is skipped.
// If request uses Bearer token (OAuth consumer), the token's client must have the scope.
export function requireCquScope(_service: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      // Session-based auth — user is directly accessing their own data, no scope check needed
      return next();
    }

    // TODO: Enforce scope when OIDC token introspection is configured.
    // Once the OIDC plugin is fully wired up, this middleware will:
    // 1. Introspect the Bearer token to get client_id and granted scopes
    // 2. Query oauth_client_cqu_scopes for `cqu:ticket:<service>` or `cqu:ticket:*`
    // 3. Return 403 FORBIDDEN if the required scope is not present
    //
    // Required scope: `cqu:ticket:${_service}`
    // Wildcard scope: `cqu:ticket:*`

    return next();
  };
}
