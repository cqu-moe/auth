# API contracts

`openapi.json` is the complete repository contract (OpenAPI 3.1.1).
`cloudflare.openapi.json` is the OpenAPI 3.0.3 projection prepared for a later API Shield import.
`endpoints.json` is the exact runtime method/path/operationId manifest.
`coverage.json` records, per operation, what Cloudflare can validate and what remains application-validated.
`auth-policy.json` records the exact authentication policy and evidence source for every runtime operation.
`shared/api-types.generated.ts` is generated from the complete contract and must not be edited manually.

The current build has 138 operations: 132 canonical, one WebSocket handshake,
zero legacy operations, and five permanent discovery operations. Generation
fails unless the runtime, complete OpenAPI, Cloudflare projection, endpoint manifest,
coverage manifest, and authentication policy have exactly the same operation set and operation IDs.

Custom JSON request schemas are generated from the same strict Zod definitions used by
the handlers. Better Auth operations retain the locked 1.6.11 plugin schemas; their
OpenAPI security is replaced only by the explicit policy ledger, including public,
optional-session, session-only, admin, Bearer, OAuth client, and two-factor-cookie cases.

## QuickLogin contract boundaries

- `GET` device list and device `DELETE` use the Auth website Cookie and require the
  configured website origin at runtime where applicable.
- Register, device `PUT`, status, refresh, and export use Bearer authentication and
  the single configured extension origin. OPTIONS is registered only for the five
  exact device resources and advertises only that resource's methods.
- Device success and error responses are native QuickLogin DTOs, including
  `QuickloginNativeError`; they are not wrapped in `{data}` or Problem Details.
- The QuickLogin root and four canonical admin policy/quota operations use `{data}`
  on success and RFC 9457 Problem Details on failure.
- Public components include the device/status/list/preference/quota/migration and
  export protocol DTOs. Internal grant records, DO account state, stored browser
  state, and pending operation state are not public schemas.

The old OAuth authorize/token paths, reset callback, and QuickLogin device paths are
retired. D01-D05 discovery paths remain because they publish metadata for the stable
issuer `https://auth.cqu.moe/api/auth`; they are not legacy business API operations.

Cloudflare retains JSON request bodies and path/query parameters. Its schema
validation does not validate form bodies, WebSocket messages, or responses; every
such exception and the native QuickLogin response contract is recorded in
`coverage.json`. The application continues to validate all of them.

Run `npm run generate:api` twice, then `npm run check:api` and `npm run lint:api`.
Generation and validation are local: they do not upload a schema, enable API Shield,
change WAF rules, or deploy the Worker.
