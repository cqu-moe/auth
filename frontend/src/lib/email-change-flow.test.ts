import { describe, expect, it } from "vitest";
import { nextEmailChangeStep, restartEmailChangeFlow } from "./email-change-flow";

describe("email change flow", () => {
  it("allows each legal mailbox-verification transition", () => {
    expect(nextEmailChangeStep("current-email", "current-otp-verified")).toBe("new-email");
    expect(nextEmailChangeStep("new-email", "new-otp-sent")).toBe("new-email-otp");
    expect(nextEmailChangeStep("new-email-otp", "email-changed")).toBe("complete");
  });

  it("rejects transitions that skip a mailbox verification step", () => {
    expect(() => nextEmailChangeStep("current-email", "email-changed")).toThrow(
      "Invalid email change transition: current-email -> email-changed"
    );
  });

  it("restarts at current-email verification while retaining only the selected new email", () => {
    expect(restartEmailChangeFlow("new@example.com")).toEqual({
      step: "current-email",
      currentOtp: "",
      currentOtpSent: false,
      newEmail: "new@example.com",
      newEmailOtp: "",
      cooldown: 0,
    });
  });
});
