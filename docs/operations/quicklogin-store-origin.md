# QuickLogin Chrome Web Store Origin compatibility (2026-10-10)

The existing public OAuth client remains `cqu-quicklogin-chrome`. Runtime Origin
validation accepts only the exact configured extension origins:

- Canary: `QUICKLOGIN_EXTENSION_ORIGIN=chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook`
- Store (optional): `QUICKLOGIN_STORE_EXTENSION_ORIGIN=chrome-extension://ainapeknaclcpoioimonkodmoakhacjd`

Omitting the store variable retains canary-only behavior. An invalid configured
Origin fails closed. Wildcards, suffixes, paths, non-extension URLs and missing
request Origins cannot authenticate extension device routes. Successful CORS
reflects the accepted requesting Origin without credentials; v3 overview and
resume-ticket retain their website-session boundary and do not grant extension CORS.

Before deploying the dual-Origin configuration, update the existing OAuth client's
`redirectUris` through the authenticated administrator interface to exactly:

1. `https://igfidegfgfoofnoncpmbcokbffjmmook.chromiumapp.org/`
2. `https://ainapeknaclcpoioimonkodmoakhacjd.chromiumapp.org/`

Keep its client ID, PKCE, scopes, grants and primary `metadata.extensionOrigin`
unchanged. The registration helper validates this expected callback set and rejects
an existing mismatched record; it does not silently update clients or migrate grants.

The local HTTP and workerd regressions cover both exact Origins, code/refresh token
response CORS, authenticated v2/v3 device registration, unauthenticated failures,
lookalike rejection and website-only restrictions. A merged commit, a deployed
Worker and actual installed Chrome Web Store acceptance are separate evidence.
