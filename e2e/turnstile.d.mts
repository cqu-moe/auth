export declare const TURNSTILE_TOKEN_HEADER: 'x-turnstile-token';
export declare const TURNSTILE_SCRIPT_URL: 'https://challenges.cloudflare.com/turnstile/v0/api.js';
export declare const TURNSTILE_SECRET: 'synthetic-e2e-turnstile-secret';
export declare function turnstileAction(path: string): 'signup' | 'password-login' | 'password-reset' | 'email-verification' | 'email-change' | null;
export declare function encodeTurnstileToken(action: string, hostname: string): string;
export declare function parseTurnstileToken(token: unknown): { action: string; hostname: string; nonce: string } | null;
export declare function turnstileHeaders(path: string, origin?: string): Record<string, string>;
export declare const turnstileFixtureScript: string;
export declare function fulfillTurnstileFixture(route: unknown): Promise<void>;
