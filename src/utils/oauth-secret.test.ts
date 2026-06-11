import { describe, it, expect } from "vitest";
import { hashOAuthClientSecret, generateOAuthClientSecret } from "./oauth-secret";

describe("hashOAuthClientSecret", () => {
  it("matches SHA-256 + base64url(no padding) spec (= plugin defaultHasher)", async () => {
    const secret = "test-secret-123";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await hashOAuthClientSecret(secret)).toBe(b64);
  });
});

describe("generateOAuthClientSecret", () => {
  it("returns a 32-char url-safe random string, unique per call", () => {
    const a = generateOAuthClientSecret();
    const b = generateOAuthClientSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});
