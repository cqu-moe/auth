import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const bytes = (value: string) => new TextEncoder().encode(value);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out;
};
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const hash = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", value));
const counter = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; };
const derInteger = (value: Uint8Array) => {
  let i = 0; while (i < value.length - 1 && value[i] === 0) i++;
  let trimmed = value.slice(i); if (trimmed[0] & 128) trimmed = join(new Uint8Array([0]), trimmed);
  return join(new Uint8Array([2, trimmed.length]), trimmed);
};

// A software authenticator fixture produces genuine P-256 WebAuthn signatures.
// Only the authenticator is simulated; HTTP, crypto verification and D1 are real.
export async function authenticator() {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey) as JsonWebKey;
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const id = encode(credential);
  let count = 0;
  return {
    id,
    async register(challenge: string, settings: { uv?: boolean; origin?: string; rpID?: string } = {}): Promise<RegistrationResponseJSON> {
      const cose = encodeCBOR(new Map<number, CBORType>([[1, 2], [3, -7], [-1, 1], [-2, decode(jwk.x!)], [-3, decode(jwk.y!)]]));
      const authData = join(await hash(bytes(settings.rpID ?? "localhost")), new Uint8Array([settings.uv === false ? 0x41 : 0x45]), counter(0), new Uint8Array(16), new Uint8Array([0, credential.length]), credential, cose);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: encode(bytes(JSON.stringify({ type: "webauthn.create", challenge, origin: settings.origin ?? "http://localhost:8787", crossOrigin: false }))),
        attestationObject: encode(encodeCBOR(new Map<string, CBORType>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))), transports: ["internal"],
      } };
    },
    async authenticate(challenge: string, settings: { uv?: boolean; origin?: string; rpID?: string } = {}): Promise<AuthenticationResponseJSON> {
      const authenticatorData = join(await hash(bytes(settings.rpID ?? "localhost")), new Uint8Array([settings.uv === false ? 1 : 5]), counter(++count));
      const clientData = bytes(JSON.stringify({ type: "webauthn.get", challenge, origin: settings.origin ?? "http://localhost:8787", crossOrigin: false }));
      const rawSignature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, join(authenticatorData, await hash(clientData))));
      const parts = join(derInteger(rawSignature.slice(0, 32)), derInteger(rawSignature.slice(32)));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { authenticatorData: encode(authenticatorData), clientDataJSON: encode(clientData), signature: encode(join(new Uint8Array([0x30, parts.length]), parts)) } };
    },
  };
}
