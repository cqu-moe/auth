import { Hono } from "hono";
import { createAuth } from "../../auth";
import { handleInvitationSignup } from "../../services/registration-invitations";
import type { HonoEnv } from "../../types";
import { AUTH_BASE_PATH } from "../../../shared/api-paths";
import { AUTH_OPERATIONS } from "../auth-operations.generated";

function canonicalRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/auth")) {
    url.pathname = `${AUTH_BASE_PATH}${url.pathname.slice("/api/auth".length)}`;
  }
  return new Request(url, request);
}

export function createAuthApi(options: { legacy?: boolean } = {}) {
  const router = new Hono<HonoEnv>();

  for (const operation of AUTH_OPERATIONS) {
    router.on(operation.method, operation.path, async (c) => {
      if (operation.path === "/error") return c.redirect("/auth/error", 302);

      const request = options.legacy ? canonicalRequest(c.req.raw) : c.req.raw;
      const auth = createAuth(c.env, request);
      if (operation.path === "/sign-up/email") {
        return handleInvitationSignup(
          request,
          c.env.DATABASE,
          (forwarded) => auth.handler(forwarded)
        );
      }
      return auth.handler(request);
    });
  }

  return router;
}
