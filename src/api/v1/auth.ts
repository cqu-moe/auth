import { expireLegacyAuthCookies } from "../../services/auth-cookies";
import { inheritAuthResetRevision } from "../../services/auth-reset-revision";
import { Hono, type Context } from "hono";
import { createAuth } from "../../auth";
import { handleInvitationSignup } from "../../services/registration-invitations";
import type { HonoEnv } from "../../types";
import { AUTH_OPERATIONS } from "../auth-operations.generated";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "../../../shared/turnstile";
import { verifyTurnstileToken } from "../../services/turnstile";
import {
  captureAuthFlowFinished,
  captureAuthFlowStarted,
} from "../../lib/posthog";
import {
  authFlowDescriptor,
  classifyAuthFlowResponse,
  readResponseShape,
  responseUserId,
  type AuthFlowDescriptor,
} from "./auth-telemetry";

async function finishAuthFlowTelemetry(
  c: Context<HonoEnv>,
  descriptor: AuthFlowDescriptor,
  operationId: string | null,
  startedAt: number,
  response: Response,
  auth: ReturnType<typeof createAuth>
): Promise<void> {
  if (!descriptor.finish || !operationId) return;
  const payload = await readResponseShape(response);
  let distinctId: string | undefined;
  if (descriptor.flow === "login") {
    distinctId = responseUserId(payload);
  } else {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const userId = (session?.user as { id?: unknown } | undefined)?.id;
      if (typeof userId === "string" && userId) distinctId = userId;
    } catch {
      // Authentication telemetry must not turn a session lookup into a business failure.
    }
  }
  captureAuthFlowFinished(
    c,
    descriptor.flow,
    operationId,
    classifyAuthFlowResponse(descriptor, response, payload),
    {
      operation: descriptor.operation,
      stage: descriptor.stage,
      method: c.req.method,
    },
    { durationMs: Date.now() - startedAt, distinctId }
  );
}

export function createAuthApi() {
  const router = new Hono<HonoEnv>();
  router.use("*", async (c, next) => {
    await next();
    expireLegacyAuthCookies(c.res.headers, c.req.header("cookie"), c.env.BETTER_AUTH_URL);
  });

  for (const operation of AUTH_OPERATIONS) {
    router.on(operation.method, operation.path, async (c) => {
      if (operation.path === "/error") return c.redirect("/auth/error", 302);

      const turnstileAction = operation.method === "POST"
        ? TURNSTILE_ACTIONS[operation.path as keyof typeof TURNSTILE_ACTIONS]
        : undefined;
      if (turnstileAction) {
        const verification = await verifyTurnstileToken(
          c.env,
          c.req.header(TURNSTILE_TOKEN_HEADER),
          turnstileAction
        );
        if (!verification.ok) {
          return c.json(
            { code: verification.code, message: verification.message },
            verification.status
          );
        }
      }

      // Provider DPoP must see the configured public origin, never a proxy's
      // internal bind address or untrusted Forwarded/X-Forwarded-* headers.
      const publicUrl = new URL(c.req.url);
      const origin = new URL(c.env.BETTER_AUTH_URL);
      publicUrl.protocol = origin.protocol;
      publicUrl.host = origin.host;
      const request = new Request(publicUrl, c.req.raw);
      inheritAuthResetRevision(c.env.DATABASE, c.req.raw, request);
      const auth = createAuth(c.env, request);
      const descriptor = authFlowDescriptor(operation.method, operation.path);
      const operationId = descriptor
        ? captureAuthFlowStarted(c, descriptor.flow, {
          operation: descriptor.operation,
          stage: descriptor.stage,
          method: c.req.method,
        })
        : null;
      const startedAt = Date.now();
      let response: Response;
      try {
        if (operation.path === "/sign-up/email") {
          response = await handleInvitationSignup(
            request,
            c.env.DATABASE,
            (forwarded) => auth.handler(forwarded)
          );
        } else {
          response = await auth.handler(request);
        }
      } catch (error) {
        if (descriptor) {
          captureAuthFlowFinished(
            c,
            descriptor.flow,
            operationId,
            "failure",
            {
              operation: descriptor.operation,
              stage: descriptor.stage,
              method: c.req.method,
              error_code: "AUTH_HANDLER_ERROR",
            },
            { durationMs: Date.now() - startedAt }
          );
        }
        throw error;
      }
      if (descriptor) {
        const completion = finishAuthFlowTelemetry(
          c,
          descriptor,
          operationId,
          startedAt,
          response,
          auth
        ).catch(() => undefined);
        try {
          c.executionCtx.waitUntil(completion);
        } catch {
          void completion;
        }
      }
      return response;
    });
  }

  return router;
}
