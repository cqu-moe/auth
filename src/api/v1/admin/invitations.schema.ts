import { z } from "@hono/zod-openapi";

export const CreateInvitationBody = z.strictObject({
  preset: z.string().min(1).nullable().optional(),
});

export const RegistrationSettingsBody = z.strictObject({
  invitationRequired: z.boolean(),
});
