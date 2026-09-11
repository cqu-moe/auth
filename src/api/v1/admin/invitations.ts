import { Hono } from "hono";
import { createAuth } from "../../../auth";
import { requireAdmin } from "../../../middleware/authentication";
import {
  getPresetItems,
  isInvitationRequired,
  setInvitationRequired,
} from "../../../services/entitlements";
import {
  createRegistrationInvitation,
  InvitationError,
  listRegistrationInvitations,
  revokeRegistrationInvitation,
} from "../../../services/registration-invitations";
import type { HonoEnv } from "../../../types";
import { problem } from "../../problem";
import { CreateInvitationBody, RegistrationSettingsBody } from "./invitations.schema";

async function parseOptionalJson(c: Parameters<typeof problem>[0]) {
  const raw = await c.req.text();
  if (!raw.trim()) return { ok: true as const, value: {} };
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
    return { ok: false as const, response: problem(c, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求体", 415) };
  }
  try {
    return { ok: true as const, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false as const, response: problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400) };
  }
}

export function createAdminInvitationsApi() {
  const api = new Hono<HonoEnv>();
  api.use("/*", requireAdmin);

  api.get("/registration-invitations", async (c) =>
    c.json({ data: await listRegistrationInvitations(c.env.DATABASE) })
  );
  api.post("/registration-invitations", async (c) => {
    const parsedBody = await parseOptionalJson(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = CreateInvitationBody.safeParse(parsedBody.value);
    if (!parsed.success) return problem(c, "INVALID_BODY", "请求体无效", 400);
    const preset = parsed.data.preset ?? null;
    if (preset !== null && !(await getPresetItems(c.env.DATABASE, preset))) {
      return problem(c, "UNKNOWN_PRESET", "未知预设", 400);
    }
    try {
      const invitation = await createRegistrationInvitation(
        c.env.DATABASE,
        c.get("user").id,
        { preset }
      );
      const registrationUrl = new URL("/register", c.env.BETTER_AUTH_URL);
      registrationUrl.searchParams.set("code", invitation.code);
      return c.json({ data: { ...invitation, registrationUrl: registrationUrl.toString() } }, 201);
    } catch (error) {
      if (error instanceof InvitationError) return problem(c, error.code, error.message, error.status);
      throw error;
    }
  });
  api.delete("/registration-invitations/:code", async (c) => {
    try {
      await revokeRegistrationInvitation(c.env.DATABASE, c.req.param("code"));
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof InvitationError) return problem(c, error.code, error.message, error.status);
      throw error;
    }
  });

  api.get("/registration-settings", async (c) =>
    c.json({ data: { invitationRequired: await isInvitationRequired(c.env.DATABASE) } })
  );
  api.put("/registration-settings", async (c) => {
    const auth = createAuth(c.env, c.req.raw);
    const permission = await auth.api.userHasPermission({
      headers: c.req.raw.headers,
      body: { permissions: { entitlement: ["assign"] } },
    });
    if (!permission.success) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
    }
    const parsed = RegistrationSettingsBody.safeParse(input);
    if (!parsed.success) return problem(c, "INVALID_BODY", "请求体无效", 400);
    await setInvitationRequired(c.env.DATABASE, parsed.data.invitationRequired);
    return c.json({ data: parsed.data });
  });
  return api;
}

export function createPublicRegistrationSettingsApi() {
  const api = new Hono<HonoEnv>();
  api.get("/", async (c) =>
    c.json({ data: { invitationRequired: await isInvitationRequired(c.env.DATABASE) } })
  );
  return api;
}
