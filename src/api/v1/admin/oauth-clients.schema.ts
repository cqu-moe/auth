import { z } from "@hono/zod-openapi";

const NullableString = z.string().nullable();
const NullableStrings = z.array(z.string()).nullable();

export const OAuthClientCreateBody = z.strictObject({
  redirect_uris: z.array(z.url()).min(1),
  scope: z.string().optional(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  contacts: z.array(z.string().min(1)).min(1).optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
  software_statement: z.string().optional(),
  post_logout_redirect_uris: z.array(z.url()).min(1).optional(),
  token_endpoint_auth_method: z.enum([
    "none", "client_secret_basic", "client_secret_post",
  ]).default("client_secret_basic").optional(),
  grant_types: z.array(z.enum([
    "authorization_code", "client_credentials", "refresh_token",
  ])).default(["authorization_code"]).optional(),
  response_types: z.array(z.literal("code")).default(["code"]).optional(),
  type: z.enum(["web", "native", "user-agent-based"]).optional(),
  client_secret_expires_at: z.union([z.string(), z.number()]).default(0).optional(),
  skip_consent: z.boolean().optional(),
  enable_end_session: z.boolean().optional(),
  require_pkce: z.literal(true).optional(),
  dpop_bound_access_tokens: z.boolean().optional(),
  subject_type: z.enum(["public", "pairwise"]).optional(),
  metadata: z.looseObject({}).optional(),
});

export const OAuthClientPatchBody = z.strictObject({
  client_name: NullableString.optional(),
  client_uri: NullableString.optional(),
  logo_uri: NullableString.optional(),
  tos_uri: NullableString.optional(),
  policy_uri: NullableString.optional(),
  token_endpoint_auth_method: NullableString.optional(),
  type: NullableString.optional(),
  subject_type: NullableString.optional(),
  contacts: NullableStrings.optional(),
  redirect_uris: NullableStrings.optional(),
  post_logout_redirect_uris: NullableStrings.optional(),
  grant_types: NullableStrings.optional(),
  response_types: NullableStrings.optional(),
  skip_consent: z.boolean().optional(),
  enable_end_session: z.boolean().optional(),
  require_pkce: z.literal(true).optional(),
  dpop_bound_access_tokens: z.boolean().optional(),
  disabled: z.boolean().optional(),
  metadata: z.looseObject({}).nullable().optional(),
  scope: NullableString.optional(),
}).refine((value) => Object.keys(value).length > 0);

export const OAuthClientScopesBody = z.strictObject({
  scopes: z.array(z.string()).refine((values) => new Set(values).size === values.length),
});

export const OAuthClientSecretBody = z.strictObject({});
