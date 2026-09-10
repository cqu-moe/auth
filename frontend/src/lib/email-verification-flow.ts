export type EmailVerificationError = {
  code?: string;
  message?: string;
} | null | undefined;

interface EmailVerificationActions {
  verifyEmail(input: {
    email: string;
    otp: string;
  }): Promise<{ data: unknown; error: EmailVerificationError }>;
  refreshSession(): Promise<unknown>;
}

export async function completeEmailVerification(
  actions: EmailVerificationActions,
  email: string,
  otp: string
): Promise<EmailVerificationError> {
  const { error } = await actions.verifyEmail({ email, otp });
  if (error) return error;

  await actions.refreshSession();
  return null;
}
