import { enrollStrongSession } from "../../src/test-utils/auth-strength";
import { applyD1Migrations, env } from "cloudflare:test";
import { vi } from "vitest";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { createAuth } from "../../src/auth";
import worker from "../../src/index";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "../../shared/turnstile";

type TestRole = "user" | "admin" | "superAdmin";

let migrated = false;
let sequence = 0;

async function ensureMigrations() {
  if (migrated) return;
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
  migrated = true;
}

function requestContext() {
  const pending: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext,
    drain: () => Promise.all(pending),
  };
}

function cookieHeader(headers: Headers): string {
  const setCookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
  return setCookies
    .map((setCookie) => setCookie.split(";", 1)[0])
    .filter((cookie) => !cookie.endsWith("="))
    .join("; ");
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION_VALUES = new Set<string>(Object.values(TURNSTILE_ACTIONS));

function protectedTurnstileAction(path: string, origin: URL, method: string) {
  if (method.toUpperCase() !== "POST") return undefined;
  const pathname = new URL(path, origin).pathname;
  const prefix = "/api/v1/auth";
  if (!pathname.startsWith(prefix)) return undefined;
  return TURNSTILE_ACTIONS[pathname.slice(prefix.length) as keyof typeof TURNSTILE_ACTIONS];
}

export function withTurnstileToken(
  path: string,
  init: RequestInit,
  origin = env.BETTER_AUTH_URL
): RequestInit {
  const url = new URL(origin);
  const action = protectedTurnstileAction(path, url, init.method ?? "GET");
  if (!action) return init;
  const headers = new Headers(init.headers);
  headers.set(
    TURNSTILE_TOKEN_HEADER,
    `local-do:${action}:${url.hostname}:${crypto.randomUUID()}`
  );
  return { ...init, headers };
}

export async function withFakeResend<T>(
  run: () => Promise<T>,
  expectedOrigin = env.BETTER_AUTH_URL
): Promise<T> {
  const redeemedNonces = new Set<string>();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === SITEVERIFY_URL) {
      const body = await request.json() as { secret?: string; response?: string };
      const token = body.response?.match(/^local-do:([^:]+):(.+):([0-9a-f-]+)$/);
      const action = token?.[1];
      const hostname = token?.[2];
      const nonce = token?.[3];
      const valid = body.secret === env.TURNSTILE_SECRET &&
        action !== undefined && TURNSTILE_ACTION_VALUES.has(action) &&
        hostname === new URL(expectedOrigin).hostname &&
        nonce !== undefined && !redeemedNonces.has(nonce);
      if (valid && nonce) redeemedNonces.add(nonce);
      return Response.json({
        success: valid,
        action: valid ? action : undefined,
        hostname: valid ? hostname : undefined,
        "error-codes": valid ? [] : ["invalid-input-response"],
      });
    }
    if (new URL(request.url).hostname !== "api.resend.com") {
      throw new Error(`unstubbed outbound request: ${request.method} ${request.url}`);
    }
    return Response.json({ id: "local-mail" });
  });
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return result;
  } finally {
    fetchSpy.mockRestore();
  }
}

export async function createApiFixture() {
  await ensureMigrations();
  const origin = env.BETTER_AUTH_URL;

  async function request(path: string, init?: RequestInit) {
    return withFakeResend(async () => {
      const execution = requestContext();
      const routedInit = withTurnstileToken(path, init ?? {}, origin);
      const response = await worker.fetch(
        new Request(new URL(path, origin), routedInit),
        env,
        execution.context
      );
      await execution.drain();
      return response;
    });
  }

  async function reauthenticateAdmin(headers: Headers) {
    const auth = createAuth(env, new Request(origin));
    const session = await auth.api.getSession({ headers });
    const context = await auth.$context;
    const factor = await context.adapter.findOne<{ secret: string }>({
      model: "twoFactor", where: [{ field: "userId", value: session!.user.id }],
    });
    const secret = await symmetricDecrypt({ key: context.secretConfig, data: factor!.secret });
    const proofHeaders = new Headers(headers);
    proofHeaders.set("origin", origin);
    proofHeaders.set("content-type", "application/json");
    const post = (path: string, body: unknown) => request(`/api/v1/auth/security/${path}`, {
      method: "POST", headers: proofHeaders, body: JSON.stringify(body),
    });
    const challenged = await post("challenge", { password: "local-test-password", purpose: "admin" });
    if (!challenged.ok) throw new Error(`admin challenge failed: ${await challenged.text()}`);
    const { challenge } = await challenged.json<{ challenge?: string }>();
    if (!challenge) throw new Error("expected admin factor challenge");
    const completed = await post("complete", { challenge, method: "totp", code: await createOTP(secret).totp() });
    if (!completed.ok) throw new Error(`admin challenge completion failed: ${await completed.text()}`);
  }

  async function signIn(role: TestRole, strong = true): Promise<Headers> {
    const id = sequence++;
    const email = `fixture-${role}-${id}@example.com`;
    const auth = createAuth(env, new Request(`${origin}/login`));
    const signup = await withFakeResend(() => auth.api.signUpEmail({
      body: { email, password: "local-test-password", name: `Fixture ${role}` },
      returnHeaders: true,
    }));
    if (role !== "user") {
      const ctx = await auth.$context;
      await ctx.adapter.update({
        model: "user",
        where: [{ field: "id", value: signup.response.user.id }],
        update: { role },
      });
      const signedIn = await auth.api.signInEmail({
        body: { email, password: "local-test-password" },
        returnHeaders: true,
      });
      const headers = new Headers({ cookie: cookieHeader(signedIn.headers), "cf-connecting-ip": `198.51.100.${id % 250 + 1}` });
      if (!strong) return headers;
      const verified = await enrollStrongSession(auth, headers, "local-test-password");
      verified.set("cf-connecting-ip", headers.get("cf-connecting-ip")!);
      await reauthenticateAdmin(verified);
      return verified;
    }
    return new Headers({ cookie: cookieHeader(signup.headers) });
  }

  async function issueToken(input: {
    scopes: string[];
    clientId: string;
    userId: string;
  }): Promise<Headers> {
    const auth = createAuth(env, new Request(`${origin}/oauth/authorize`));
    const issuer = `${origin}/api/auth`;
    const signed = await auth.api.signJWT({
      body: {
        payload: {
          sub: input.userId,
          azp: input.clientId,
          client_id: input.clientId,
          scope: input.scopes.join(" "),
        },
        overrideOptions: {
          jwt: { issuer, audience: issuer, expirationTime: "15m" },
        },
      },
    });
    return new Headers({ authorization: `Bearer ${signed.token}` });
  }

  return {
    request,
    signIn,
    reauthenticateAdmin,
    issueToken,
    database: env.DATABASE,
    close: async () => {},
  };
}
