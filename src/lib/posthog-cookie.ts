export function postHogCookieResetResponse(
  projectToken: string | undefined,
  location = "/",
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: location,
  });
  const token = projectToken?.trim();
  if (token) {
    const encoded = token.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ");
    const name = `ph_${encoded}_posthog`;
    headers.append("Set-Cookie", `${name}=; Max-Age=0; Path=/; Secure; SameSite=Lax`);
    headers.append("Set-Cookie", `${name}=; Max-Age=0; Path=/; Domain=.cqu.moe; Secure; SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers });
}
