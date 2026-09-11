import { verifyJwsAccessToken } from "better-auth/oauth2";
import { createAuth } from "../auth";
import type { Env } from "../types";

interface JwksDocument {
  keys: JsonWebKey[];
}

async function readLocalJwks(env: Env): Promise<JwksDocument> {
  const request = new Request(`${env.BETTER_AUTH_URL}/api/auth/jwks`, {
    headers: { accept: "application/json" },
  });
  const response = await createAuth(env, request).handler(request);
  if (!response.ok) throw new Error("LOCAL_JWKS_UNAVAILABLE");
  const body = await response.json<unknown>();
  if (!body || typeof body !== "object" ||
      !Array.isArray((body as { keys?: unknown }).keys)) {
    throw new Error("LOCAL_JWKS_INVALID");
  }
  return body as JwksDocument;
}

export function verifyAuthAccessToken(token: string, env: Env) {
  return verifyJwsAccessToken(token, {
    verifyOptions: {
      issuer: env.BETTER_AUTH_URL,
      audience: env.BETTER_AUTH_URL,
    },
    jwksFetch: () => readLocalJwks(env),
  });
}
