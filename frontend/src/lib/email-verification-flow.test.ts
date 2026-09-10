import { describe, expect, it, vi } from "vitest";
import { completeEmailVerification } from "./email-verification-flow";

describe("email verification OTP flow", () => {
  it("refreshes the session after verification before reporting success", async () => {
    const events: string[] = [];
    const error = await completeEmailVerification(
      {
        verifyEmail: async () => {
          events.push("verified");
          return { data: { status: true }, error: null };
        },
        refreshSession: async () => {
          events.push("refresh-started");
          await Promise.resolve();
          events.push("refresh-finished");
        },
      },
      "user@example.com",
      "123456"
    );
    events.push("completed");

    expect(error).toBeNull();
    expect(events).toEqual([
      "verified",
      "refresh-started",
      "refresh-finished",
      "completed",
    ]);
  });

  it("does not refresh the session when the OTP is rejected", async () => {
    const authError = { code: "INVALID_OTP", message: "Invalid OTP" };
    const refreshSession = vi.fn(async () => undefined);

    const error = await completeEmailVerification(
      {
        verifyEmail: async () => ({ data: null, error: authError }),
        refreshSession,
      },
      "user@example.com",
      "000000"
    );

    expect(error).toBe(authError);
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
