# API contracts

`openapi.json` is the complete repository contract (OpenAPI 3.1.1).
`cloudflare.openapi.json` is the OpenAPI 3.0.3 projection prepared for later API Shield import.
`endpoints.json` records canonical, legacy, discovery, and WebSocket operations.
`coverage.json` records Cloudflare request-validation gaps; responses, form bodies, and WebSocket messages remain application-validated.

Run `npm run generate:api`, `npm run check:api`, and `npm run lint:api` locally. Generation and validation do not upload a schema or change Cloudflare configuration.
