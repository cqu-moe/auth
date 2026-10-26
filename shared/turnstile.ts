export const TURNSTILE_TOKEN_HEADER = "x-turnstile-token";

export const TURNSTILE_ACTIONS = {
  "/sign-up/email": "signup",
  "/sign-in/email": "password-login",
  "/request-password-reset": "password-reset",
  "/email-otp/send-verification-otp": "email-verification",
  "/send-verification-email": "email-verification",
  "/email-otp/request-email-change": "email-change",
} as const;

export type TurnstileAction =
  | "signup"
  | "password-login"
  | "password-reset"
  | "email-verification"
  | "email-change";
