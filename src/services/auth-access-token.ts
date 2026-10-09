import { createDpopReplayStore, enforceDpopBinding, getDpopJktFromPayload, parseAccessTokenAuthorization, verifyJwsAccessToken } from "better-auth/oauth2";
import { currentDeviceAuthority } from "./device-authority";
import { createAuth } from "../auth";
import { authUrls } from "../auth-config";
import type { Env } from "../types";

interface JwksDocument { keys: JsonWebKey[] }

async function readLocalJwks(env: Env): Promise<JwksDocument> {
  const { jwksUrl } = authUrls(env.BETTER_AUTH_URL);
  const request = new Request(jwksUrl, { headers: { accept: "application/json" } });
  const response = await createAuth(env, request).handler(request);
  if (!response.ok) throw new Error("LOCAL_JWKS_UNAVAILABLE");
  const body = await response.json<unknown>();
  if (!body || typeof body !== "object" ||
      !Array.isArray((body as { keys?: unknown }).keys)) {
    throw new Error("LOCAL_JWKS_INVALID");
  }
  return body as JwksDocument;
}

async function verifySignatureAndAuthority(token: string, env: Env) {
  const { issuer } = authUrls(env.BETTER_AUTH_URL);
  const payload = await verifyJwsAccessToken(token, {
    verifyOptions: { issuer, audience: issuer },
    jwksFetch: () => readLocalJwks(env),
  });
  const { adapter } = await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context;
  if (!(await currentDeviceAuthority(adapter, payload))) throw new Error("DEVICE_AUTHORITY_INACTIVE");
  return payload;
}

/** Token-only compatibility callers must never accept sender-constrained tokens. */
export async function verifyAuthAccessToken(token: string, env: Env) {
  const payload = await verifySignatureAndAuthority(token, env);
  if (getDpopJktFromPayload(payload)) throw new Error("DPOP_REQUEST_REQUIRED");
  return payload;
}

/** Verify the signature locally, then use native request binding and D1 replay protection. */
export async function verifyAuthAccessTokenRequest(request: Request, env: Env) {
  const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
  if (!authorization?.token || authorization.scheme === "Unknown") throw new Error("INVALID_AUTHORIZATION");
  const payload = await verifySignatureAndAuthority(authorization.token, env);
  const { internalAdapter } = await createAuth(env, request).$context;
  await enforceDpopBinding({
    payload, authorization,
    proofJwt: request.headers.get("dpop"),
    method: request.method,
    url: request.url,
    replayStore: createDpopReplayStore(internalAdapter),
  });
  return payload;
}
