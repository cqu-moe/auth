export type EmailChangeStep = "current-email" | "new-email" | "new-email-otp" | "complete";
export type EmailChangeEvent = "current-otp-verified" | "new-otp-sent" | "email-changed";

export function nextEmailChangeStep(
  step: EmailChangeStep,
  event: EmailChangeEvent
): EmailChangeStep {
  if (step === "current-email" && event === "current-otp-verified") return "new-email";
  if (step === "new-email" && event === "new-otp-sent") return "new-email-otp";
  if (step === "new-email-otp" && event === "email-changed") return "complete";
  throw new Error(`Invalid email change transition: ${step} -> ${event}`);
}
