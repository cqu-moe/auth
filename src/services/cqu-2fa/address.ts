export function localPart(address: string): string {
  const at = address.indexOf("@");
  if (at <= 0) return "";
  return address.slice(0, at).split("+")[0].trim().toLowerCase();
}
