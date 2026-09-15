import { cquQuickloginV3 } from "../../routes/cqu-quicklogin-v3";
import { createRoute, z } from "@hono/zod-openapi";
import { createApiRouter } from "../validation";
import type { HonoEnv } from "../../types";
import { createCquBindingApi } from "./cqu-binding";
import { createCquServiceTicketsApi } from "./cqu-service-tickets";
import { createCquQuickloginApi } from "./cqu-quicklogin";
import { createAdminUsersApi } from "./admin/users";
import {
  createAdminInvitationsApi,
  createPublicRegistrationSettingsApi,
} from "./admin/invitations";
import { createAdminEntitlementsApi } from "./admin/entitlements";
import { createAdminOAuthClientsApi } from "./admin/oauth-clients";
import { createAdminQuickloginApi } from "./admin/quicklogin";
import { cquQuickloginDevices } from "../../routes/cqu-quicklogin-devices";

const Health = z.object({
  data: z.object({
    status: z.literal("ok"),
    timestamp: z.iso.datetime(),
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  responses: {
    200: {
      description: "Service health",
      content: { "application/json": { schema: Health } },
    },
  },
});

export function createV1Api() {
  const api = createApiRouter<HonoEnv>();
  api.openapi(healthRoute, (c) =>
    c.json({ data: { status: "ok" as const, timestamp: new Date().toISOString() } }, 200)
  );
  api.route("/cqu/binding", createCquBindingApi());
  api.route("/cqu/service-tickets", createCquServiceTicketsApi());
  api.route("/cqu/quicklogin", cquQuickloginV3);
  api.route("/cqu/quicklogin/devices", cquQuickloginDevices);
  api.route("/cqu/quicklogin", createCquQuickloginApi());
  api.route("/admin/users", createAdminUsersApi());
  api.route("/admin", createAdminInvitationsApi());
  api.route("/admin", createAdminEntitlementsApi());
  api.route("/admin", createAdminQuickloginApi());
  api.route("/admin/oauth-clients", createAdminOAuthClientsApi());
  api.route("/registration-settings", createPublicRegistrationSettingsApi());
  return api;
}
