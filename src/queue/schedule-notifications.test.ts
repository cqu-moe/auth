import { describe, expect, it, vi } from "vitest";
import {
  processScheduleNotification,
  validateScheduleNotificationMessage,
  type ScheduleNotificationMessageV1,
} from "./schedule-notifications";

const validMessage = (): ScheduleNotificationMessageV1 => ({
  version: 1,
  notificationId: "schedule-v1-user-old-new",
  userId: "user-1",
  subject: "课表与考试安排有更新",
  html: "<p>2026年9月8日 星期二 08:30–10:05</p>",
  text: "2026年9月8日 星期二 08:30–10:05",
  createdAt: "2026-09-07T12:00:00.000Z",
});

describe("validateScheduleNotificationMessage", () => {
  it("accepts a bounded V1 message and strips untrusted extra fields", () => {
    expect(validateScheduleNotificationMessage({
      ...validMessage(),
      email: "attacker@example.com",
      from: "attacker@example.com",
    })).toEqual(validMessage());
  });

  it("rejects malformed and oversized messages", () => {
    expect(validateScheduleNotificationMessage({ ...validMessage(), version: 2 })).toBeNull();
    expect(validateScheduleNotificationMessage({ ...validMessage(), subject: "x".repeat(201) })).toBeNull();
    expect(validateScheduleNotificationMessage({ ...validMessage(), html: "x".repeat(100 * 1024 + 1) })).toBeNull();
    expect(validateScheduleNotificationMessage({ ...validMessage(), createdAt: "not-a-date" })).toBeNull();
  });
});

describe("processScheduleNotification", () => {
  it("uses the current verified Auth email, fixed sender, and notification idempotency key", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ data: { id: "email-1" }, error: null });

    const result = await processScheduleNotification(
      { ...validMessage(), email: "attacker@example.com" },
      {
        resolveRecipient: vi.fn().mockResolvedValue({
          email: "current@example.com",
          emailVerified: true,
          eligible: true,
        }),
        sendEmail,
      },
    );

    expect(result).toBe("ack");
    expect(sendEmail).toHaveBeenCalledWith(
      {
        from: "CQU Schedule <noreply@schedule.cqu.moe>",
        to: "current@example.com",
        subject: validMessage().subject,
        html: validMessage().html,
        text: validMessage().text,
      },
      { idempotencyKey: validMessage().notificationId },
    );
  });

  it.each([
    ["missing user", null],
    ["unverified email", { email: "u@example.com", emailVerified: false, eligible: true }],
    ["revoked entitlement", { email: "u@example.com", emailVerified: true, eligible: false }],
  ])("acks without sending for %s", async (_name, recipient) => {
    const sendEmail = vi.fn();
    const result = await processScheduleNotification(validMessage(), {
      resolveRecipient: vi.fn().mockResolvedValue(recipient),
      sendEmail,
    });
    expect(result).toBe("ack");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])("retries Resend status %s", async (statusCode) => {
    const result = await processScheduleNotification(validMessage(), {
      resolveRecipient: vi.fn().mockResolvedValue({
        email: "u@example.com",
        emailVerified: true,
        eligible: true,
      }),
      sendEmail: vi.fn().mockResolvedValue({
        data: null,
        error: { statusCode, message: "temporary" },
      }),
    });
    expect(result).toBe("retry");
  });

  it("retries a concurrent Resend idempotent request but rejects a reused key with changed payload", async () => {
    const makeDependencies = (name: string) => ({
      resolveRecipient: vi.fn().mockResolvedValue({
        email: "u@example.com",
        emailVerified: true,
        eligible: true,
      }),
      sendEmail: vi.fn().mockResolvedValue({
        data: null,
        error: { name, statusCode: 409, message: "conflict" },
      }),
    });

    expect(await processScheduleNotification(
      validMessage(),
      makeDependencies("concurrent_idempotent_requests"),
    )).toBe("retry");
    expect(await processScheduleNotification(
      validMessage(),
      makeDependencies("invalid_idempotent_request"),
    )).toBe("ack");
  });

  it("acks permanent Resend errors and invalid input", async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      data: null,
      error: { statusCode: 422, message: "invalid" },
    });
    const dependencies = {
      resolveRecipient: vi.fn().mockResolvedValue({
        email: "u@example.com",
        emailVerified: true,
        eligible: true,
      }),
      sendEmail,
    };

    expect(await processScheduleNotification(validMessage(), dependencies)).toBe("ack");
    expect(await processScheduleNotification({ nope: true }, dependencies)).toBe("ack");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
