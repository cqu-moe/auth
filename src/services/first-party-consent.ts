import { APIError, getSessionFromCtx } from "better-auth/api";

type Context = Parameters<typeof getSessionFromCtx>[0];
// skipConsent is server-owned native approval, unavailable to self-registration.
// Administrator entitlements still govern the actual business operation.
export async function enforceFirstPartyConsent(ctx: Context): Promise<void> {
  if (ctx.path === "/oauth2/authorize") {
    const query = { ...ctx.query, ...ctx.body };
    const prompt: string[] = typeof query.prompt === "string" ? query.prompt.split(/\s+/).filter(Boolean) : [];
    if (!prompt.includes("consent") || prompt.includes("none") || typeof query.client_id !== "string") return;
    const client = await ctx.context.adapter.findOne<{ skipConsent?: boolean; disabled?: boolean }>({ model: "oauthClient", where: [{ field: "clientId", value: query.client_id }] });
    if (!client?.skipConsent || client.disabled) return;
    const nextPrompt = prompt.filter(value => value !== "consent").join(" ");
    // The native hook merger keeps absent/undefined fields from the original
    // object. Delete this one field in place before returning the context.
    if (nextPrompt) {
      ctx.query.prompt = nextPrompt;
      if (ctx.body) ctx.body.prompt = nextPrompt;
    } else {
      delete ctx.query.prompt;
      if (ctx.body) delete ctx.body.prompt;
    }
  }
  if (["/oauth2/delete-consent", "/oauth2/update-consent"].includes(ctx.path)) {
    const session = await getSessionFromCtx(ctx);
    if (!session || typeof ctx.body?.id !== "string") return;
    const consent = await ctx.context.adapter.findOne<{ userId: string; clientId: string }>({ model: "oauthConsent", where: [{ field: "id", value: ctx.body.id }] });
    if (!consent || consent.userId !== session.user.id) return; // Native ownership errors remain authoritative.
    const client = await ctx.context.adapter.findOne<{ skipConsent?: boolean }>({ model: "oauthClient", where: [{ field: "clientId", value: consent.clientId }] });
    if (client?.skipConsent) throw new APIError("FORBIDDEN", { code: "FIRST_PARTY_DEFAULT_AUTHORIZATION", message: "第一方应用默认授权；可在设备管理中退出具体设备" });
  }
}
