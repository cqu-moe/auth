import { Hono } from "hono";
import { createAuth } from "../../../auth";
import { requireAdmin, requireRecentAdmin } from "../../../middleware/authentication";
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
import { JsonBodyError, jsonBodyProblem, parseJsonBody } from "../../validation";
import { CreateInvitationBody, RegistrationSettingsBody } from "./invitations.schema";

export function createAdminInvitationsApi() {
  const api = new Hono<HonoEnv>();
  api.use("/*", requireAdmin);

  api.get("/registration-invitations", async (c) =>
    c.json({ data: await listRegistrationInvitations(c.env.DATABASE) })
  );
  api.post("/registration-invitations", async (c) => {
    let body;
    try {
      body = await parseJsonBody(c.req.raw, CreateInvitationBody, { optionalEmpty: true });
    } catch (error) {
      if (error instanceof JsonBodyError) return jsonBodyProblem(c, error);
      throw error;
    }
    const preset = body.preset ?? null;
    if (preset !== null) {
      const auth = createAuth(c.env, c.req.raw);
      const permission = await auth.api.userHasPermission({
        headers: c.req.raw.headers,
        body: { permissions: { entitlement: ["assign"] } },
      });
      if (!permission.success) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
      const rejected = await requireRecentAdmin(c, async () => {});
      if (rejected) return rejected;
    }
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
  api.put("/registration-settings", requireRecentAdmin, async (c) => {
    const auth = createAuth(c.env, c.req.raw);
    const permission = await auth.api.userHasPermission({
      headers: c.req.raw.headers,
      body: { permissions: { entitlement: ["assign"] } },
    });
    if (!permission.success) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    try {
      const input = await parseJsonBody(c.req.raw, RegistrationSettingsBody);
      await setInvitationRequired(c.env.DATABASE, input.invitationRequired);
      return c.json({ data: input });
    } catch (error) {
      if (error instanceof JsonBodyError) return jsonBodyProblem(c, error);
      throw error;
    }
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
