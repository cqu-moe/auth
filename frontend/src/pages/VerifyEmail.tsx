import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { getVerificationLinkErrorMessage } from "../lib/email-verification-routing";
import { sanitizePostLoginRedirect, withRedirectParam } from "../lib/post-login-redirect";
import { refetchOnReturn } from "../lib/refetch-on-return";

type SendStatus = "idle" | "sending" | "sent" | "error";

export default function VerifyEmail() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [error, setError] = useState("");
  const user = session?.user as { email?: string } | undefined;
  const verificationError = getVerificationLinkErrorMessage(searchParams.get("error"));

  useEffect(() => refetchOnReturn(() => refetchSession()), [refetchSession]);

  const handleResend = async () => {
    if (!user?.email) return;

    setSendStatus("sending");
    setError("");
    const { error: sendError } = await authClient.sendVerificationEmail({
      email: user.email,
      callbackURL: withRedirectParam("/verify-email?verified=1", postLoginRedirect),
    });

    if (sendError) {
      setSendStatus("error");
      setError(sendError.message ?? "发送失败，请稍后重试");
      return;
    }

    setSendStatus("sent");
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate(withRedirectParam("/login", postLoginRedirect), { replace: true });
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">CQU Auth</h1>
          <p className="mt-2 text-gray-500">完成邮箱验证后即可继续使用</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-5">
            <svg
              className="w-8 h-8 text-blue-600"
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

          <h2 className="text-xl font-semibold text-gray-900">请验证你的邮箱</h2>
          {verificationError && (
            <p className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700" role="alert">
              {verificationError}
            </p>
          )}
          <p className="mt-3 text-sm leading-6 text-gray-500">
            验证邮件已发送至
            <span className="block font-medium text-gray-800 break-all">{user?.email}</span>
            请点击邮件中的链接完成验证。
          </p>

          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={handleResend}
              disabled={sendStatus === "sending" || sendStatus === "sent"}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {sendStatus === "sending" && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {sendStatus === "sending"
                ? "发送中..."
                : sendStatus === "sent"
                  ? "验证邮件已重新发送"
                  : "重新发送验证邮件"}
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              className="w-full py-2.5 px-4 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg transition-colors"
            >
              退出登录
            </button>
          </div>

          {sendStatus === "sent" && (
            <p className="mt-4 text-sm text-green-700">邮件已发送，请检查收件箱和垃圾邮件目录。</p>
          )}
          {error && (
            <p className="mt-4 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
