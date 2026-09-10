import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { completeEmailVerification } from "../lib/email-verification-flow";
import {
  isExternalHttpTarget,
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { refetchOnReturn } from "../lib/refetch-on-return";
import { mapAuthError, normalizeOtp } from "../lib/two-factor";

type SendStatus = "idle" | "sending" | "sent" | "error";

export default function VerifyEmail() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const [otp, setOtp] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [verificationError, setVerificationError] = useState("");
  const [sendError, setSendError] = useState("");
  const user = session?.user as { email?: string } | undefined;

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = normalizeOtp(otp);
    if (code.length !== 6) {
      setVerificationError("输入邮件中的 6 位数字验证码");
      return;
    }
    if (!user?.email) {
      setVerificationError("无法读取当前登录邮箱，请退出后重新登录");
      return;
    }

    setVerificationError("");
    setVerifying(true);
    const authError = await completeEmailVerification(
      {
        verifyEmail: (input) => authClient.emailOtp.verifyEmail(input),
        refreshSession: () => refetchSession(),
      },
      user.email,
      code
    );
    setVerifying(false);

    if (authError) {
      setVerificationError(
        mapAuthError(
          authError.code,
          authError.message ?? "邮箱验证码验证失败，请重新输入"
        )
      );
      return;
    }

    const destination = postLoginRedirect ?? "/settings";
    if (isExternalHttpTarget(destination)) {
      window.location.replace(destination);
      return;
    }
    navigate(destination, { replace: true });
  };

  useEffect(() => refetchOnReturn(() => refetchSession()), [refetchSession]);

  const handleResend = async () => {
    if (!user?.email) {
      setSendStatus("error");
      setSendError("无法读取当前登录邮箱，请退出后重新登录");
      return;
    }

    setSendStatus("sending");
    setSendError("");
    const { error: authError } = await authClient.emailOtp.sendVerificationOtp({
      email: user.email,
      type: "email-verification",
    });

    if (authError) {
      setSendStatus("error");
      setSendError(mapAuthError(authError.code, authError.message ?? "验证码发送失败，请稍后重试"));
      return;
    }

    setSendStatus("sent");
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate(withRedirectParam("/login", postLoginRedirect), { replace: true });
  };

  return (
    <div className="min-h-[100dvh] bg-gray-50 px-4 py-10 antialiased sm:py-16">
      <main className="mx-auto w-full max-w-md">
        <p className="mb-6 text-center text-sm font-semibold tracking-tight text-gray-900">
          CQU Auth
        </p>

        <section
          aria-labelledby="verify-email-heading"
          className="rounded-2xl border border-gray-950/[0.08] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_rgba(16,24,40,0.06)] sm:p-8"
        >
          <div className="flex items-center gap-3">
            <div className="pointer-events-none flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8m-16 11h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium text-blue-700">最后一步</p>
              <h1
                id="verify-email-heading"
                className="text-balance text-xl font-semibold tracking-tight text-gray-950"
              >
                输入邮箱验证码
              </h1>
            </div>
          </div>

          <p className="mt-5 text-sm leading-6 text-gray-600">
            输入发送至以下邮箱的 6 位验证码。验证码 5 分钟内有效。
            <span className="mt-1 block break-all font-medium text-gray-950">
              {user?.email ?? "当前登录邮箱"}
            </span>
          </p>

          <form onSubmit={handleVerify} className="mt-6 space-y-4 text-left" aria-busy={verifying}>
            <div>
              <label htmlFor="email-verification-otp" className="mb-1.5 block text-sm font-medium text-gray-700">
                六位验证码
              </label>
              <input
                id="email-verification-otp"
                name="otp"
                type="text"
                value={otp}
                onChange={(event) => setOtp(normalizeOtp(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                disabled={verifying}
                spellCheck={false}
                enterKeyHint="done"
                aria-invalid={Boolean(verificationError)}
                aria-describedby={verificationError ? "email-verification-error" : "email-verification-help"}
                data-lpignore="true"
                data-1p-ignore
                className={`min-h-12 w-full touch-manipulation rounded-xl border px-4 py-2 text-center font-mono text-xl font-semibold tabular-nums tracking-[0.4em] text-gray-950 outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-out placeholder:text-gray-300 focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2 motion-reduce:transition-none disabled:bg-gray-100 ${
                  verificationError ? "border-red-300 bg-red-50/40" : "border-gray-300 bg-white hover:border-gray-400"
                }`}
                placeholder="000000"
              />
              {!verificationError && (
                <p id="email-verification-help" className="mt-2 text-xs text-gray-500">
                  仅输入邮件中的数字
                </p>
              )}
              {verificationError && (
                <p
                  id="email-verification-error"
                  className="mt-2 flex items-start gap-1.5 text-sm text-red-700"
                  role="alert"
                >
                  <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="7.5" stroke="currentColor" />
                    <path d="M10 6.5v4.25M10 13.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
                  </svg>
                  {verificationError}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={verifying || sendStatus === "sending"}
              className="flex min-h-11 w-full touch-manipulation items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-blue-700 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 motion-reduce:transform-none motion-reduce:transition-none disabled:bg-blue-300"
            >
              {verifying && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent motion-reduce:animate-none" />
              )}
              {verifying ? "验证中…" : "验证并继续"}
            </button>
          </form>

          <div className="mt-5 flex min-h-11 items-center justify-center gap-1 text-sm text-gray-500">
            <span>没有收到？</span>
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={sendStatus === "sending" || verifying}
              className="min-h-11 touch-manipulation rounded-lg px-2 font-medium text-blue-700 transition-[color,background-color,transform] duration-150 ease-out hover:bg-blue-50 hover:text-blue-800 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 motion-reduce:transform-none motion-reduce:transition-none disabled:text-gray-400"
            >
              {sendStatus === "sending" ? "发送中…" : "重新发送验证码"}
            </button>
          </div>

          <div className="min-h-5 text-center text-sm" aria-live="polite">
            {sendStatus === "sent" && (
              <p className="text-green-700">新验证码已发送，请检查收件箱。</p>
            )}
            {sendStatus === "error" && (
              <p className="text-red-700" role="alert">{sendError}</p>
            )}
          </div>

          <div className="mt-5 border-t border-gray-950/[0.08] pt-3 text-center">
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={verifying || sendStatus === "sending"}
              className="min-h-11 touch-manipulation rounded-lg px-3 text-sm font-medium text-gray-500 transition-[color,background-color,transform] duration-150 ease-out hover:bg-gray-50 hover:text-gray-800 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 motion-reduce:transform-none motion-reduce:transition-none disabled:text-gray-300"
            >
              退出当前账户
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
