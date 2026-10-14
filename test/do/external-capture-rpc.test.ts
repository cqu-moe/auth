import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { AuthService } from "../../src/rpc";
import {
  parseExternalCaptureResult,
  type ExternalCaptureRecipe,
} from "../../src/services/cqu-external-capture";
import { createAuth } from "../../src/auth";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));

async function fixture(options?: { external?: boolean; rpcMethods?: string[] }) {
  const id = crypto.randomUUID();
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  const now = new Date();
  const user = await adapter.create<{ id: string }>({
    model: "user",
    data: {
      name: "External capture user",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      role: "user",
    },
  });
  await adapter.create({
    model: "oauthClient",
    data: {
      clientId: id,
      clientSecret: await hashOAuthClientSecret("rpc-test-secret"),
      redirectUris: ["https://schedule.example/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
      metadata: {
        subsystem: "calendar",
        rpcMethods: options?.rpcMethods ?? ["cquExternalCapture"],
      },
    },
  });
  if (options?.external !== false) {
    await env.DATABASE.prepare(
      "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'external', '1')"
    ).bind(user.id).run();
  }
  await env.DATABASE.prepare(
    "INSERT INTO cqu_credentials (id, user_id, student_id, encrypted_password, iv) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, user.id, "student", "encrypted", "iv").run();

  const fetch = vi.fn(async (_request: Request) => Response.json({
    ok: true,
    contractVersion: 1,
    sourceType: "admin_class",
    target: { id: "class-1", name: "电气工程2026-01班" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [
        {
          courseName: "高等数学",
          instructorName: "教师",
          roomName: "D101",
          position: "1",
          campusName: "A校区",
          weekDay: 1,
          teachingWeek: "110",
          period: "101",
          exprProjectName: null,
          assignTeachingObject: [{ adminClassId: "class-1" }],
          bearer: "SECRET",
        },
      ],
      maxSection: 12,
    },
    state: { cookies: ["SECRET"] },
  }));
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch }),
  } as unknown as DurableObjectNamespace;
  const rpc = new AuthService(createExecutionContext(), { ...env, CQU_SESSION: namespace });
  return {
    rpc,
    fetch,
    args: { clientId: id, clientSecret: "rpc-test-secret", userId: user.id },
    userId: user.id,
  };
}

it("dispatches one fixed admin-class capture and returns only whitelisted business rows", async () => {
  const f = await fixture();
  const result = await f.rpc.cquExternalCapture({
    ...f.args,
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气工程2026-01班",
    expectedSessionId: "session-current",
    deadlineAt: Date.now() + 90_000,
  });

  expect(result).toEqual({
    contractVersion: 1,
    sourceType: "admin_class",
    target: { id: "class-1", name: "电气工程2026-01班" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [{
        courseName: "高等数学",
        instructorName: "教师",
        roomName: "D101",
        position: "1",
        campusName: "A校区",
        weekDay: 1,
        teachingWeek: "110",
        period: "101",
        assignTeachingObject: [{ adminClassId: "class-1" }],
      }],
      maxSection: 12,
    },
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const request = f.fetch.mock.calls[0][0];
  expect(new URL(request.url).pathname).toBe("/external-capture");
  expect(request.method).toBe("POST");
  await expect(request.clone().json()).resolves.toEqual({
    action: "admin_class_capture",
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气工程2026-01班",
    expectedSessionId: "session-current",
    deadlineAt: expect.any(Number),
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

it("dispatches one fixed instructor capture and preserves only exact-ID ownership", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => Response.json({
    ok: true,
    contractVersion: 1,
    sourceType: "instructor",
    target: { id: "teacher-1", name: "张三" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [{
        courseName: "高等数学",
        instructorName: "张三",
        roomName: "D101",
        position: "1",
        campusName: "A校区",
        weekDay: 1,
        teachingWeek: "110",
        period: "101",
        instructorIdList: ["teacher-other", "teacher-1"],
        mobilePhone: "SECRET",
      }],
      maxSection: 12,
    },
    state: { cookies: ["SECRET"] },
  }));

  const result = await f.rpc.cquExternalCapture({
    ...f.args,
    sourceType: "instructor",
    targetId: "teacher-1",
    targetName: "张三",
    expectedSessionId: "session-current",
    deadlineAt: Date.now() + 90_000,
  });

  expect(result).toEqual({
    contractVersion: 1,
    sourceType: "instructor",
    target: { id: "teacher-1", name: "张三" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [{
        courseName: "高等数学",
        instructorName: "张三",
        roomName: "D101",
        position: "1",
        campusName: "A校区",
        weekDay: 1,
        teachingWeek: "110",
        period: "101",
        instructorIdList: ["teacher-other", "teacher-1"],
      }],
      maxSection: 12,
    },
  });
  const request = f.fetch.mock.calls[0][0];
  await expect(request.clone().json()).resolves.toEqual({
    action: "instructor_capture",
    sourceType: "instructor",
    targetId: "teacher-1",
    targetName: "张三",
    expectedSessionId: "session-current",
    deadlineAt: expect.any(Number),
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

it("rejects transport controls and unsupported sources before browser dispatch", async () => {
  const f = await fixture();
  await expect(f.rpc.cquExternalCapture({
    ...f.args,
    sourceType: "student",
    targetId: "student-1",
    targetName: "学生",
  } as unknown as Parameters<typeof f.rpc.cquExternalCapture>[0]))
    .resolves.toEqual({ error: "INVALID_REQUEST" });
  await expect(f.rpc.cquExternalCapture({
    ...f.args,
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气1班",
    url: "https://example.com",
  } as unknown as Parameters<typeof f.rpc.cquExternalCapture>[0]))
    .resolves.toEqual({ error: "INVALID_REQUEST" });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("keeps owned bad content skippable and rejects unknown arrays at the typed boundary", () => {
  const recipe: ExternalCaptureRecipe = {
    action: "admin_class_capture",
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气工程2026-01班",
    expectedSessionId: "",
  };
  const payload = {
    contractVersion: 1,
    sourceType: "admin_class",
    target: { id: "class-1", name: "电气工程2026-01班" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [{
        courseName: "不可验证课程",
        instructorName: 42,
        weekDay: 1,
        teachingWeek: "110",
        period: "101",
        assignTeachingObject: [{ adminClassId: "class-1" }],
      }],
      maxSection: 12,
    },
  };

  expect(parseExternalCaptureResult(payload, recipe)).toEqual({
    contractVersion: 1,
    sourceType: "admin_class",
    target: { id: "class-1", name: "电气工程2026-01班" },
    session: { id: "session-current", name: "2026秋", beginDate: "2026-09-07" },
    timetable: {
      classTimetableVOList: [{ assignTeachingObject: [{ adminClassId: "class-1" }] }],
      maxSection: 12,
    },
  });
  expect(parseExternalCaptureResult({
    ...payload,
    timetable: { ...payload.timetable, unknownBusinessRows: [] },
  }, recipe)).toEqual({ error: "SCHEMA_INVALID" });
});

it("requires method approval, external entitlement and an active school binding", async () => {
  const unapproved = await fixture({ rpcMethods: ["cquExternalSearch"] });
  await expect(unapproved.rpc.cquExternalCapture({
    ...unapproved.args,
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气1班",
  })).resolves.toEqual({ error: "FORBIDDEN" });

  const unentitled = await fixture({ external: false });
  await expect(unentitled.rpc.cquExternalCapture({
    ...unentitled.args,
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气1班",
  })).resolves.toEqual({ error: "FORBIDDEN" });

  const bound = await fixture();
  await env.DATABASE.prepare("UPDATE cqu_credentials SET status = ? WHERE user_id = ?")
    .bind("deleting", bound.userId).run();
  await expect(bound.rpc.cquExternalCapture({
    ...bound.args,
    sourceType: "admin_class",
    targetId: "class-1",
    targetName: "电气1班",
  })).resolves.toEqual({ error: "NO_CQU_BINDING" });
  expect(bound.fetch).not.toHaveBeenCalled();
});
