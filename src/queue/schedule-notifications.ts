import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { user } from "../db/schema";
import { resolveCaps } from "../services/entitlements";
import type { Env } from "../types";

const MAX_NOTIFICATION_ID = 128;
const MAX_USER_ID = 128;
const MAX_SUBJECT = 200;
const MAX_HTML = 100 * 1024;
const MAX_TEXT = 50 * 1024;
const RETRY_DELAY_SECONDS = 60;

export interface ScheduleNotificationMessageV1 {
  version: 1;
  notificationId: string;
  userId: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
}

interface Recipient {
  email: string;
  emailVerified: boolean;
  eligible: boolean;
}

interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface SendResult {
  data: unknown;
  error: { statusCode?: number | null; message?: string } | null;
}

export interface NotificationDependencies {
  resolveRecipient(userId: string): Promise<Recipient | null>;
  sendEmail(
    input: SendEmailInput,
    options: { idempotencyKey: string },
  ): Promise<SendResult>;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateScheduleNotificationMessage(
  input: unknown,
): ScheduleNotificationMessageV1 | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !boundedString(value.notificationId, MAX_NOTIFICATION_ID) ||
    !boundedString(value.userId, MAX_USER_ID) ||
    !boundedString(value.subject, MAX_SUBJECT) ||
    !boundedString(value.html, MAX_HTML) ||
    !boundedString(value.text, MAX_TEXT) ||
    !boundedString(value.createdAt, 64) ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    return null;
  }

  return {
    version: 1,
    notificationId: value.notificationId,
    userId: value.userId,
    subject: value.subject,
    html: value.html,
    text: value.text,
    createdAt: value.createdAt,
  };
}

function isRetryableStatus(statusCode: number | null | undefined): boolean {
  return statusCode == null || statusCode === 429 || statusCode >= 500;
}

export async function processScheduleNotification(
  input: unknown,
  dependencies: NotificationDependencies,
): Promise<"ack" | "retry"> {
  const notification = validateScheduleNotificationMessage(input);
  if (!notification) {
    console.warn(JSON.stringify({
      event: "queue.schedule_notification.invalid",
      message: "Invalid schedule notification message",
    }));
    return "ack";
  }

  try {
    const recipient = await dependencies.resolveRecipient(notification.userId);
    if (!recipient || !recipient.eligible || !recipient.emailVerified || !recipient.email) {
      console.log(JSON.stringify({
        event: "queue.schedule_notification.skipped",
        notificationId: notification.notificationId,
        userId: notification.userId,
        reason: !recipient
          ? "user_missing"
          : !recipient.eligible
            ? "not_entitled"
            : "email_unverified",
      }));
      return "ack";
    }

    const result = await dependencies.sendEmail(
      {
        from: "重庆大学课表 <noreply@cqu.moe>",
        to: recipient.email,
        subject: notification.subject,
        html: notification.html,
        text: notification.text,
      },
      { idempotencyKey: notification.notificationId },
    );

    if (result.error) {
      const retry = isRetryableStatus(result.error.statusCode);
      console.error(JSON.stringify({
        event: retry
          ? "queue.schedule_notification.send_retry"
          : "queue.schedule_notification.send_rejected",
        notificationId: notification.notificationId,
        userId: notification.userId,
        statusCode: result.error.statusCode ?? null,
      }));
      return retry ? "retry" : "ack";
    }

    console.log(JSON.stringify({
      event: "queue.schedule_notification.sent",
      notificationId: notification.notificationId,
      userId: notification.userId,
    }));
    return "ack";
  } catch (error) {
    console.error(JSON.stringify({
      event: "queue.schedule_notification.send_retry",
      notificationId: notification.notificationId,
      userId: notification.userId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return "retry";
  }
}

function createDependencies(env: Env): NotificationDependencies {
  const resend = new Resend(env.RESEND_API_KEY);
  return {
    async resolveRecipient(userId) {
      const db = drizzle(env.DATABASE);
      const [account, caps] = await Promise.all([
        db
          .select({ email: user.email, emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, userId))
          .get(),
        resolveCaps(env.DATABASE, userId, "calendar"),
      ]);
      if (!account) return null;
      return {
        ...account,
        eligible: caps.calendar.change_notification === true,
      };
    },
    sendEmail(input, options) {
      return resend.emails.send(input, options);
    },
  };
}

export async function processScheduleNotificationBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const dependencies = createDependencies(env);
  await Promise.allSettled(batch.messages.map(async (message) => {
    const outcome = await processScheduleNotification(message.body, dependencies);
    if (outcome === "retry") message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    else message.ack();
  }));
}
