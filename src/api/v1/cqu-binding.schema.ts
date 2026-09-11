import { z } from "@hono/zod-openapi";

export const CreateCquBindingBody = z.strictObject({
  kind: z.enum(["direct", "forward"]).optional(),
});

export const CquCredentialsBody = z.strictObject({
  studentId: z.string().min(1),
  password: z.string().min(1),
});
