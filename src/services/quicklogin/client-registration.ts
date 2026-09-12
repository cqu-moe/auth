import type { Env } from "../../types";
import { DEVICE_SCOPE } from "./contracts";

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
  skipConsent: false;
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
  public: true;
  type: "user-agent-based";
  requirePKCE: true;
  referenceId: null;
  metadata: { quickloginOfficial: true; extensionOrigin: string };
}

export class QuickloginClientRegistrationError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "EXISTING_CLIENT_MISMATCH") {
    super(code);
  }
}

function extensionId(origin: string): string {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!match) throw new QuickloginClientRegistrationError("INVALID_CONFIG");
  return match[1];
}

function metadata(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; }
    catch { return null; }
  }
  return typeof value === "object" && value !== null
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
  return value.clientId === expected.clientId && value.clientSecret == null &&
    value.disabled === false && value.skipConsent === false &&
    value.enableEndSession === false && value.subjectType === "public" &&
    sameArray(value.scopes, expected.scopes) &&
    sameArray(value.redirectUris, expected.redirectUris) &&
    sameArray(value.postLogoutRedirectUris, []) &&
    value.tokenEndpointAuthMethod === "none" &&
    sameArray(value.grantTypes, expected.grantTypes) &&
    sameArray(value.responseTypes, expected.responseTypes) &&
    value.public === true && value.type === "user-agent-based" &&
    value.requirePKCE === true && meta?.quickloginOfficial === true &&
    meta.extensionOrigin === expected.metadata.extensionOrigin;
}

export async function ensureQuickloginOAuthClient(
  env: Pick<Env, "QUICKLOGIN_CLIENT_ID" | "QUICKLOGIN_EXTENSION_ORIGIN">,
  adapter: ClientAdapter,
  now = new Date()
): Promise<QuickloginOAuthClientRecord> {
  if (!env.QUICKLOGIN_CLIENT_ID) {
    throw new QuickloginClientRegistrationError("INVALID_CONFIG");
  }
  const id = extensionId(env.QUICKLOGIN_EXTENSION_ORIGIN);
  const desired: QuickloginOAuthClientRecord = {
    clientId: env.QUICKLOGIN_CLIENT_ID,
    clientSecret: null,
    disabled: false,
    skipConsent: false,
    enableEndSession: false,
    subjectType: "public",
    scopes: ["openid", "offline_access", DEVICE_SCOPE],
    userId: null,
    createdAt: now,
    updatedAt: now,
    name: "CQU 快捷登录",
    redirectUris: [`https://${id}.chromiumapp.org/`],
    postLogoutRedirectUris: [],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    public: true,
    type: "user-agent-based",
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
