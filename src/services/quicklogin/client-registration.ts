import type { Env } from "../../types";
import { DEVICE_SCOPE } from "./contracts";
import { quickloginExtensionOrigins } from "./extension-origin";

export interface ClientAdapter {
  findOne<T>(input: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
  }): Promise<T | null>;
  create(input: {
    model: string;
    data: QuickloginOAuthClientRecord;
  }): Promise<QuickloginOAuthClientRecord>;
}

export interface QuickloginOAuthClientRecord {
  clientId: string;
  clientSecret: null;
  disabled: false;
  skipConsent: true;
  enableEndSession: false;
  subjectType: "public";
  scopes: string[];
  userId: null;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: ["code"];
  applicationType: "web";
  requirePKCE: true;
  referenceId: null;
  metadata: { quickloginOfficial: true; extensionOrigin: string };
}

export class QuickloginClientRegistrationError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "EXISTING_CLIENT_MISMATCH") {
    super(code);
  }
}

function metadata(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; }
    catch { return null; }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sameArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function matches(
  value: Partial<QuickloginOAuthClientRecord>,
  expected: QuickloginOAuthClientRecord
) {
  const meta = metadata(value.metadata);
  const metadataKeys = meta ? Object.keys(meta).sort() : [];
  return value.clientId === expected.clientId && value.clientSecret === null &&
    value.disabled === false && value.skipConsent === true &&
    value.enableEndSession === false && value.subjectType === "public" &&
    sameArray(value.scopes, expected.scopes) &&
    value.userId === null && value.name === expected.name &&
    sameArray(value.redirectUris, expected.redirectUris) &&
    sameArray(value.postLogoutRedirectUris, []) &&
    value.tokenEndpointAuthMethod === "none" &&
    sameArray(value.grantTypes, expected.grantTypes) &&
    sameArray(value.responseTypes, expected.responseTypes) &&
    value.applicationType === "web" &&
    value.requirePKCE === true && value.referenceId === null &&
    value.createdAt instanceof Date && value.updatedAt instanceof Date &&
    metadataKeys.length === 2 && metadataKeys[0] === "extensionOrigin" &&
    metadataKeys[1] === "quickloginOfficial" &&
    meta?.quickloginOfficial === true &&
    meta.extensionOrigin === expected.metadata.extensionOrigin;
}

export async function ensureQuickloginOAuthClient(
  env: Pick<Env, "QUICKLOGIN_CLIENT_ID" | "QUICKLOGIN_EXTENSION_ORIGIN" | "QUICKLOGIN_STORE_EXTENSION_ORIGIN">,
  adapter: ClientAdapter,
  now = new Date()
): Promise<QuickloginOAuthClientRecord> {
  if (!env.QUICKLOGIN_CLIENT_ID) {
    throw new QuickloginClientRegistrationError("INVALID_CONFIG");
  }
  const origins = quickloginExtensionOrigins(env);
  if (!origins.length) throw new QuickloginClientRegistrationError("INVALID_CONFIG");
  const desired: QuickloginOAuthClientRecord = {
    clientId: env.QUICKLOGIN_CLIENT_ID,
    clientSecret: null,
    disabled: false,
    skipConsent: true,
    enableEndSession: false,
    subjectType: "public",
    scopes: ["openid", "offline_access", DEVICE_SCOPE],
    userId: null,
    createdAt: now,
    updatedAt: now,
    name: "CQU 快捷登录",
    redirectUris: origins.map(origin => `https://${origin.slice("chrome-extension://".length)}.chromiumapp.org/`),
    postLogoutRedirectUris: [],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    applicationType: "web",
    requirePKCE: true,
    referenceId: null,
    metadata: { quickloginOfficial: true, extensionOrigin: env.QUICKLOGIN_EXTENSION_ORIGIN },
  };
  const existing = await adapter.findOne<Partial<QuickloginOAuthClientRecord>>({
    model: "oauthClient",
    where: [{ field: "clientId", value: desired.clientId }],
  });
  if (existing) {
    if (!matches(existing, desired)) {
      throw new QuickloginClientRegistrationError("EXISTING_CLIENT_MISMATCH");
    }
    return existing as QuickloginOAuthClientRecord;
  }
  return adapter.create({ model: "oauthClient", data: desired });
}
