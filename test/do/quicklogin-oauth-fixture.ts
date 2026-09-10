import { makeSignature } from "better-auth/crypto";
import type { Env } from "../../src/types";
import { createAuth } from "../../src/auth";

export const OFFICIAL_CLIENT_ID = "quicklogin-test-client";
export const OTHER_CLIENT_ID = "ordinary-test-client";
export const OFFICIAL_REDIRECT_URI =
  "https://quicklogin-test.chromiumapp.org/";
export const OTHER_REDIRECT_URI = "https://ordinary.example/callback";

const BASE_URL = "http://localhost:8787";

export interface WebsiteSession {
  userId: string;
  headers: Headers;
}

export interface OAuthFixture {
  env: Env;
  authHandler(request: Request): Promise<Response>;
  websiteSession: WebsiteSession;
}

export interface AuthorizedInstall {
  request(): Request;
  refresh(): Promise<AuthorizedInstall>;
}

export class OAuthFixtureError extends Error {
  constructor(
    public readonly stage: "authorize" | "consent" | "token" | "refresh",
    public readonly status: number,
    public readonly oauthError?: string,
    public readonly errorDescription?: string
  ) {
    super(
      `${stage}:${oauthError ?? status}${errorDescription ? `:${errorDescription}` : ""}`
    );
    this.name = "OAuthFixtureError";
  }
}

interface AuthorizeOptions {
  websiteSession: WebsiteSession;
  clientId?: string;
  redirectUri?: string;
  scopes?: string[];
  verifier?: string | null;
  exchangeVerifier?: string;
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

function formRequest(path: string, body: URLSearchParams): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
    },
    body,
  });
}

async function redirectTarget(response: Response): Promise<URL> {
  const location = response.headers.get("location");
  if (location) return new URL(location, BASE_URL);
  const body = await response.clone().json<{
    url?: string;
    redirect_uri?: string;
  }>();
  const target = body.url ?? body.redirect_uri;
  if (!target) throw new Error(`missing redirect target (${response.status})`);
  return new URL(target, BASE_URL);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function createClient(
  fixtureEnv: Env,
  input: {
    clientId: string;
    redirectUri: string;
    metadata: Record<string, unknown>;
    scopes: string[];
  }
): Promise<void> {
  const auth = createAuth(
    fixtureEnv,
    new Request(`${BASE_URL}/api/auth/oauth2/authorize`)
  );
  const ctx = await auth.$context;
  const now = new Date();
  await ctx.adapter.create({
    model: "oauthClient",
    data: {
      clientId: input.clientId,
      clientSecret: null,
      disabled: false,
      skipConsent: false,
      enableEndSession: false,
      subjectType: "public",
      scopes: input.scopes,
      userId: null,
      createdAt: now,
      updatedAt: now,
      name: input.clientId,
      redirectUris: [input.redirectUri],
      postLogoutRedirectUris: [],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      public: true,
      type: "user-agent-based",
      requirePKCE: true,
      referenceId: null,
      metadata: input.metadata,
    },
  });
}

export async function createOAuthFixture(fixtureEnv: Env): Promise<OAuthFixture> {
  const authHandler = (request: Request) => createAuth(fixtureEnv, request).handler(request);
  const bootstrap = createAuth(
    fixtureEnv,
    new Request(`${BASE_URL}/api/auth/get-session`)
  );
  const ctx = await bootstrap.$context;
  const now = new Date();
  const userId = crypto.randomUUID();
  await ctx.adapter.create({
    model: "user",
    forceAllowId: true,
    data: {
      id: userId,
      name: "OAuth Test User",
      email: `${userId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
      twoFactorEnabled: false,
    },
  });
  const session = await ctx.internalAdapter.createSession(userId);
  if (!session) throw new Error("failed to create test session");
  const signature = await makeSignature(
    session.token,
    fixtureEnv.BETTER_AUTH_SECRET
  );
  const headers = new Headers({
    cookie: `${ctx.authCookies.sessionToken.name}=${session.token}.${signature}`,
  });

  await createClient(fixtureEnv, {
    clientId: OFFICIAL_CLIENT_ID,
    redirectUri: OFFICIAL_REDIRECT_URI,
    metadata: { quickloginOfficial: true },
    scopes: ["openid", "offline_access", "cqu:quicklogin:device"],
  });
  await createClient(fixtureEnv, {
    clientId: OTHER_CLIENT_ID,
    redirectUri: OTHER_REDIRECT_URI,
    metadata: { subsystem: "calendar" },
    scopes: ["openid", "offline_access", "cqu:quicklogin:device"],
  });

  return {
    env: fixtureEnv,
    authHandler,
    websiteSession: { userId, headers },
  };
}

async function authorizeInstall(
  fixture: OAuthFixture,
  options: AuthorizeOptions
): Promise<AuthorizedInstall> {
  const clientId = options.clientId ?? OFFICIAL_CLIENT_ID;
  const redirectUri = options.redirectUri ?? OFFICIAL_REDIRECT_URI;
  const scopes = options.scopes ?? [
    "openid",
    "offline_access",
    "cqu:quicklogin:device",
  ];
  const verifier =
    options.verifier === undefined
      ? `verifier-${crypto.randomUUID()}-0123456789`
      : options.verifier;
  const authorizeUrl = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scopes.join(" "));
  authorizeUrl.searchParams.set("state", crypto.randomUUID());
  authorizeUrl.searchParams.set("prompt", "consent");
  if (verifier !== null) {
    authorizeUrl.searchParams.set("code_challenge", await codeChallenge(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
  }
  const authorizeHeaders = new Headers(options.websiteSession.headers);
  authorizeHeaders.set("accept", "application/json");
  const authorizeResponse = await fixture.authHandler(
    new Request(authorizeUrl, { headers: authorizeHeaders, redirect: "manual" })
  );
  const consentUrl = await redirectTarget(authorizeResponse);
  const authorizeError = consentUrl.searchParams.get("error");
  if (authorizeError || consentUrl.pathname !== "/oauth/authorize") {
    throw new OAuthFixtureError(
      "authorize",
      authorizeResponse.status,
      authorizeError ?? undefined
    );
  }

  const consentHeaders = new Headers(options.websiteSession.headers);
  consentHeaders.set("content-type", "application/json");
  consentHeaders.set("accept", "application/json");
  consentHeaders.set("origin", BASE_URL);
  const consentResponse = await fixture.authHandler(
    new Request(`${BASE_URL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: consentHeaders,
      body: JSON.stringify({
        accept: true,
        oauth_query: consentUrl.searchParams.toString(),
      }),
    })
  );
  const callback = await redirectTarget(consentResponse);
  const consentError = callback.searchParams.get("error");
  const code = callback.searchParams.get("code");
  if (consentError || !code) {
    throw new OAuthFixtureError(
      "consent",
      consentResponse.status,
      consentError ?? undefined
    );
  }

  const tokenResponse = await fixture.authHandler(
    formRequest(
      "/api/auth/oauth2/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: options.exchangeVerifier ?? verifier ?? "",
        redirect_uri: redirectUri,
        resource: BASE_URL,
      })
    )
  );
  const tokenBody = await tokenResponse.json<TokenBody>();
  if (!tokenResponse.ok || !tokenBody.access_token || !tokenBody.refresh_token) {
    throw new OAuthFixtureError(
      "token",
      tokenResponse.status,
      tokenBody.error,
      tokenBody.error_description
    );
  }

  const buildInstall = (
    accessToken: string,
    refreshToken: string
  ): AuthorizedInstall => ({
    request: () =>
      new Request(`${BASE_URL}/api/cqu/quicklogin/devices/self/status`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    refresh: async () => {
      const response = await fixture.authHandler(
        formRequest(
          "/api/auth/oauth2/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refreshToken,
            resource: BASE_URL,
          })
        )
      );
      const body = await response.json<TokenBody>();
      if (!response.ok || !body.access_token || !body.refresh_token) {
        throw new OAuthFixtureError(
          "refresh",
          response.status,
          body.error,
          body.error_description
        );
      }
      return buildInstall(body.access_token, body.refresh_token);
    },
  });

  return buildInstall(tokenBody.access_token, tokenBody.refresh_token);
}

export function authorizeOfficialInstall(
  fixture: OAuthFixture,
  options: { websiteSession: WebsiteSession }
): Promise<AuthorizedInstall> {
  return authorizeInstall(fixture, options);
}

export function authorizeWithOverrides(
  fixture: OAuthFixture,
  options: AuthorizeOptions
): Promise<AuthorizedInstall> {
  return authorizeInstall(fixture, options);
}

export function accessTokenPayload(install: AuthorizedInstall): Record<string, unknown> {
  const authorization = install.request().headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer /, "");
  const payload = token.split(".")[1];
  if (!payload) throw new Error("missing JWT payload");
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(normalized)) as Record<string, unknown>;
}
