import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import {
  isExternalHttpTarget,
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { normalizeOtp } from "../lib/two-factor";
import {
  getLoginChallengeError,
  loginChallengeMethods,
  sendLoginChallengeOtp,
  verifyLoginChallenge,
  type LoginChallengeActions,
  type LoginChallengeError,
  type LoginChallengeMethod,
} from "../lib/two-factor-challenge";

const nativeTwoFactorActions: LoginChallengeActions = {
  verifyTotp: (input) => authClient.twoFactor.verifyTotp(input),
  verifyOtp: (input) => authClient.twoFactor.verifyOtp(input),
  verifyBackupCode: (input) => authClient.twoFactor.verifyBackupCode(input),
  sendOtp: (input) => authClient.twoFactor.sendOtp(input),
};

export default function TwoFactorChallenge() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refetch: refetchSession } = authClient.useSession();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const [method, setMethod] = useState<LoginChallengeMethod>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState("");
  const [challengeExpired, setChallengeExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);

  useEffect(() => {
    if (resendSeconds <= 0) return;

    const timer = window.setTimeout(() => setResendSeconds((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  const showError = (responseError: LoginChallengeError, fallback: string) => {
    const mapped = getLoginChallengeError(responseError, fallback);
    setChallengeExpired(mapped.expired);
    setError(mapped.message);
  };

  const selectMethod = (nextMethod: LoginChallengeMethod) => {
    setMethod(nextMethod);
    setCode("");
    setError("");
    setChallengeExpired(false);
  };

  const handleSendOtp = async () => {
    setError("");
    setChallengeExpired(false);
    setSending(true);

    const { error } = await sendLoginChallengeOtp(nativeTwoFactorActions, trustDevice);

    setSending(false);
    if (error) {
      showError(error, "验证码发送失败，请稍后重试");
      return;
    }
    setResendSeconds(60);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setChallengeExpired(false);

    const value = method === "backup-code" ? code.trim() : normalizeOtp(code);
    if (!value) {
      setError(method === "backup-code" ? "请输入备用恢复码" : "请输入六位验证码");
      return;
    }

    setLoading(true);
    const result = await verifyLoginChallenge(
      nativeTwoFactorActions,
      method,
      value,
      trustDevice,
      refetchSession
    );
    setLoading(false);

    if (result.error) {
      showError(result.error, "验证失败，请重试");
      return;
    }
    const destination = postLoginRedirect ?? "/settings";
    if (isExternalHttpTarget(destination)) {
      window.location.assign(destination);
      return;
    }
    navigate(destination, { replace: true });
  };

  const isBackupCode = method === "backup-code";
  const isEmailOtp = method === "email-otp";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">二次验证</h1>
          <p className="mt-2 text-gray-500">请选择一种已启用的方式完成登录</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1" role="tablist" aria-label="验证方式">
            {loginChallengeMethods.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={method === value}
                onClick={() => selectMethod(value)}
                className={`rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                  method === value
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-5 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700" role="alert">
              {error}
              {challengeExpired && (
                <Link
                  to={withRedirectParam("/login", postLoginRedirect)}
                  className="ml-1 underline font-medium"
                >
                  返回登录
                </Link>
              )}
            </div>
          )}

          <form onSubmit={handleVerify} className="mt-6 space-y-4">
            <div>
              <label htmlFor="twoFactorCode" className="block text-sm font-medium text-gray-700 mb-1">
                {isBackupCode ? "备用恢复码" : "六位验证码"}
              </label>
              <input
                id="twoFactorCode"
                value={code}
                onChange={(event) => setCode(isBackupCode ? event.target.value : normalizeOtp(event.target.value))}
                inputMode={isBackupCode ? "text" : "numeric"}
                autoComplete="one-time-code"
                maxLength={isBackupCode ? undefined : 6}
                required
                disabled={loading || challengeExpired}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                placeholder={isBackupCode ? "输入备用恢复码" : "000000"}
              />
            </div>

            {isEmailOtp && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500">验证码将发送到您的登录邮箱。</p>
                <button
                  type="button"
                  onClick={handleSendOtp}
                  disabled={sending || resendSeconds > 0 || challengeExpired}
                  className="shrink-0 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                >
                  {sending ? "发送中..." : resendSeconds > 0 ? `${resendSeconds} 秒后可重新发送` : "发送验证码"}
                </button>
              </div>
            )}

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={trustDevice}
                onChange={(event) => setTrustDevice(event.target.checked)}
                disabled={loading || challengeExpired}
                className="mt-0.5 w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">在这台设备上保持信任 30 天</span>
            </label>

            <button
              type="submit"
              disabled={loading || challengeExpired}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {loading ? "验证中..." : "完成验证"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
