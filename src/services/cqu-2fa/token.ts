export function genAddressToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (const b of bytes) out += alphabet[b % 36];
  return out;
}
