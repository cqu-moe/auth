-- Approve only the already provisioned production extension contract.
-- Other clients and disabled/drifted registrations are untouched. Operators
-- must review the nonsecret inventory and repair drift through admin tooling.
UPDATE oauthClient SET skipConsent = 1, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE clientId = 'cqu-quicklogin-chrome'
  AND disabled = 0 AND requirePKCE = 1 AND clientSecret IS NULL AND userId IS NULL
  AND tokenEndpointAuthMethod = 'none' AND applicationType = 'web'
  AND name = 'CQU 快捷登录' AND referenceId IS NULL AND enableEndSession = 0
  AND subjectType = 'public' AND postLogoutRedirectUris = '[]'
  AND (SELECT count(*) FROM json_each(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END)) = 2
  AND redirectUris = '["https://igfidegfgfoofnoncpmbcokbffjmmook.chromiumapp.org/"]'
  AND scopes = '["openid","offline_access","cqu:quicklogin:device"]'
  AND grantTypes = '["authorization_code","refresh_token"]' AND responseTypes = '["code"]'
  AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.quickloginOfficial') END = 1
  AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.extensionOrigin') END = 'chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook';

-- Final cutover only, after consumer migration and under the documented auth
-- maintenance window. Old shared credentials must not be reusable by renaming
-- a cookie. Accounts, factors, business rights/binding and RPC clients survive.
UPDATE auth_reset_revision SET revision = revision + 1 WHERE id = 1;
DELETE FROM oauthAccessToken;
DELETE FROM oauthRefreshToken;
DELETE FROM verification;
DELETE FROM session;
