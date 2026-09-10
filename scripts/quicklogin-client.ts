export interface QuickloginClientConfig {
  clientId: string;
  redirectUri: string;
  extensionOrigin: string;
}

export function expectedQuickloginClient(input: QuickloginClientConfig) {
  return {
    clientId: input.clientId,
    public: true,
    requirePKCE: true,
    skipConsent: false,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    redirectUris: [input.redirectUri],
    scopes: ["openid", "offline_access", "cqu:quicklogin:device"],
    metadata: {
      quickloginOfficial: true,
      extensionOrigin: input.extensionOrigin,
    },
  };
}

export function quickloginClientDiff(
  actual: Record<string, unknown> | null,
  expected: ReturnType<typeof expectedQuickloginClient>
): string[] {
  if (!actual) return ["missing"];
  return Object.entries(expected).flatMap(([key, value]) =>
    JSON.stringify(actual[key]) === JSON.stringify(value) ? [] : [key]
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({
    mode: "dry-run",
    message: "Supply environment-specific public clientId, extension ID and fixed chromiumapp redirect to the controlled Better Auth admin runner.",
  }, null, 2));
}
