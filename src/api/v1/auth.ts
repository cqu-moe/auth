import { expireLegacyAuthCookies } from "../../services/auth-cookies";
import { inheritAuthResetRevision } from "../../services/auth-reset-revision";
import { Hono } from "hono";
import { createAuth } from "../../auth";
import { handleInvitationSignup } from "../../services/registration-invitations";
import type { HonoEnv } from "../../types";
import { AUTH_OPERATIONS } from "../auth-operations.generated";

export function createAuthApi() {
  const router = new Hono<HonoEnv>();
  router.use("*", async (c, next) => {
    await next();
    expireLegacyAuthCookies(c.res.headers, c.req.header("cookie"), c.env.BETTER_AUTH_URL);
  });

  for (const operation of AUTH_OPERATIONS) {
    router.on(operation.method, operation.path, async (c) => {
      if (operation.path === "/error") return c.redirect("/auth/error", 302);

      // Provider DPoP must see the configured public origin, never a proxy's
      // internal bind address or untrusted Forwarded/X-Forwarded-* headers.
      const publicUrl = new URL(c.req.url);
      const origin = new URL(c.env.BETTER_AUTH_URL);
      publicUrl.protocol = origin.protocol;
      publicUrl.host = origin.host;
      const request = new Request(publicUrl, c.req.raw);
      inheritAuthResetRevision(c.env.DATABASE, c.req.raw, request);
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
