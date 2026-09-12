import { Hono } from "hono";
import { createAuth } from "../../auth";
import { handleInvitationSignup } from "../../services/registration-invitations";
import type { HonoEnv } from "../../types";
import { AUTH_OPERATIONS } from "../auth-operations.generated";

export function createAuthApi() {
  const router = new Hono<HonoEnv>();

  for (const operation of AUTH_OPERATIONS) {
    router.on(operation.method, operation.path, async (c) => {
      if (operation.path === "/error") return c.redirect("/auth/error", 302);

      const request = c.req.raw;
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
