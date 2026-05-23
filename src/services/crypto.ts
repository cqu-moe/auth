// AES-256-GCM encrypt/decrypt using Web Crypto API
export async function encrypt(
  plaintext: string,
  keyBase64: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return {
    ciphertext: bufferToBase64(encrypted),
    iv: bufferToBase64(iv),
  };
}

export async function decrypt(
  ciphertextBase64: string,
  ivBase64: string,
  keyBase64: string
): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = base64ToBuffer(ivBase64);
  const ciphertext = base64ToBuffer(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(keyBase64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

// AES-ECB for CQU SSO password encryption (matches CQU's croypto scheme)
// IMPORTANT: In Workers with nodejs_compat, createCipheriv with ECB needs "" not null for IV
export function encryptAesEcb(plaintext: string, keyBase64: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCipheriv } = require("node:crypto") as typeof import("node:crypto");
  const key = Buffer.from(keyBase64, "base64");
  const algo =
    key.length <= 16
      ? "aes-128-ecb"
      : key.length <= 24
        ? "aes-192-ecb"
        : "aes-256-ecb";
  const cipher = createCipheriv(algo, key, "");
  return Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
