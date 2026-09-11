import { applyD1Migrations, env } from "cloudflare:test";
import { vi } from "vitest";
import { createAuth } from "../../src/auth";
import worker from "../../src/index";

type TestRole = "user" | "admin" | "superAdmin";

let migrated = false;
let sequence = 0;

async function ensureMigrations() {
  if (migrated) return;
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
  migrated = true;
}

function requestContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
}

function cookieHeader(headers: Headers): string {
  const setCookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
  return setCookies
    .map((setCookie) => setCookie.split(";", 1)[0])
    .filter((cookie) => !cookie.endsWith("="))
    .join("; ");
}

async function withFakeResend<T>(run: () => Promise<T>): Promise<T> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (new URL(request.url).hostname !== "api.resend.com") {
      throw new Error(`unstubbed outbound request: ${request.method} ${request.url}`);
    }
    return Response.json({ id: "local-mail" });
  });
  try {
    return await run();
  } finally {
    fetchSpy.mockRestore();
  }
}

export async function createApiFixture() {
  await ensureMigrations();
  const origin = env.BETTER_AUTH_URL;

  async function request(path: string, init?: RequestInit) {
    return withFakeResend(() => Promise.resolve(worker.fetch(
      new Request(new URL(path, origin), init),
      env,
      requestContext()
    )));
  }

  async function signIn(role: TestRole): Promise<Headers> {
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
    issueToken,
    database: env.DATABASE,
    close: async () => {},
  };
}
