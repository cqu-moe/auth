import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { encrypt } from "../services/crypto";
import { errorResponse } from "../utils/error";
import { cquCredentials } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { requireCquScope } from "../middleware/scope";
import { verifyAccessToken } from "better-auth/oauth2";

const cqu = new Hono<HonoEnv>();

cqu.use("/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const payload = await verifyAccessToken(token, {
        verifyOptions: {
          issuer: c.env.BETTER_AUTH_URL,
          audience: c.env.BETTER_AUTH_URL,
        },
        jwksUrl: `${c.env.BETTER_AUTH_URL}/api/auth/jwks`,
      });
      c.set("user", { id: payload.sub as string });
      return next();
    } catch {
      return errorResponse(c, "UNAUTHORIZED", "无效的访问令牌", 401);
    }
  }

  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return errorResponse(c, "UNAUTHORIZED", "未登录", 401);
  c.set("user", session.user);
  return next();
});

// POST /api/cqu/bind
cqu.post("/bind", async (c) => {
  const user = c.get("user") as { id: string };
  const { studentId, password } = await c.req.json<{
    studentId: string;
    password: string;
  }>();

  if (!studentId || !password) {
    return errorResponse(c, "MISSING_FIELDS", "缺少学号或密码", 400);
  }

  const { ciphertext, iv } = await encrypt(password, c.env.ENCRYPTION_KEY);
  const db = drizzle(c.env.DATABASE);
  const id = crypto.randomUUID();

  // Check if already bound
  const existing = await db
    .select()
    .from(cquCredentials)
    .where(eq(cquCredentials.userId, user.id))
    .get();
  if (existing) {
    return errorResponse(c, "ALREADY_BOUND", "已绑定 CQU 账号，请先解绑", 409);
  }

  await db.insert(cquCredentials).values({
    id,
    userId: user.id,
    studentId,
    encryptedPassword: ciphertext,
    iv,
  });

  // Initialize DO session
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const result = await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: user.id,
        studentId,
        encryptedPassword: ciphertext,
        iv,
      }),
    })
  );
  const initResult = await result.json<{ success: boolean; error?: string }>();

  if (!initResult.success) {
    await db.delete(cquCredentials).where(eq(cquCredentials.id, id));
    return errorResponse(
      c,
      "CQU_LOGIN_FAILED",
      initResult.error ?? "CQU 登录失败",
      400
    );
  }

  return c.json({ success: true, studentId });
});

// PUT /api/cqu/bind — atomic rebind
cqu.put("/bind", async (c) => {
  const user = c.get("user") as { id: string };
  const { studentId, password } = await c.req.json<{
    studentId: string;
    password: string;
  }>();

  if (!studentId || !password) {
    return errorResponse(c, "MISSING_FIELDS", "缺少学号或密码", 400);
  }

  const db = drizzle(c.env.DATABASE);
  const existing = await db
    .select()
    .from(cquCredentials)
    .where(eq(cquCredentials.userId, user.id))
    .get();
  if (!existing) {
    return errorResponse(c, "NOT_BOUND", "尚未绑定 CQU 账号", 400);
  }

  const { ciphertext, iv } = await encrypt(password, c.env.ENCRYPTION_KEY);

  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);

  // Destroy old session first
  await stub.fetch(new Request("https://do/destroy", { method: "POST" }));

  // Try to initialize new session — validate credentials before committing
  const result = await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: user.id,
        studentId,
        encryptedPassword: ciphertext,
        iv,
      }),
    })
  );
  const initResult = await result.json<{ success: boolean; error?: string }>();

  if (!initResult.success) {
    // Re-init old session so user doesn't lose existing binding
    await stub.fetch(
      new Request("https://do/init", {
        method: "POST",
        body: JSON.stringify({
          userId: user.id,
          studentId: existing.studentId,
          encryptedPassword: existing.encryptedPassword,
          iv: existing.iv,
        }),
      })
    );
    return errorResponse(
      c,
      "CQU_LOGIN_FAILED",
      initResult.error ?? "新账号登录失败，已保留原绑定",
      400
    );
  }

  // Credentials validated — update database
  await db
    .update(cquCredentials)
    .set({
      studentId,
      encryptedPassword: ciphertext,
      iv,
    })
    .where(eq(cquCredentials.userId, user.id));

  return c.json({ success: true, studentId });
});

// DELETE /api/cqu/bind
cqu.delete("/bind", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);
  await db.delete(cquCredentials).where(eq(cquCredentials.userId, user.id));

  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  await stub.fetch(new Request("https://do/destroy", { method: "POST" }));

  return c.json({ success: true });
});

// GET /api/cqu/status
cqu.get("/status", async (c) => {
  const user = c.get("user") as { id: string };
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const resp = await stub.fetch(new Request("https://do/status"));
  return c.json(await resp.json());
});

cqu.get("/service-ticket", async (c, next) => {
  const service = c.req.query("service");
  if (!service)
    return errorResponse(c, "MISSING_SERVICE", "缺少 service 参数", 400);
  return requireCquScope(service)(c, next);
}, async (c) => {
  const service = c.req.query("service")!;
  const user = c.get("user") as { id: string };
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const resp = await stub.fetch(
    new Request(`https://do/service-ticket?service=${service}`)
  );

  if (!resp.ok) {
    const err = await resp.json<{ error: string; code: string }>();
    return errorResponse(c, err.code ?? "ST_FAILED", err.error, resp.status);
  }

  return c.json(await resp.json());
});

export { cqu };
