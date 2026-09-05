import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { validateNewEmail } from "../lib/account-settings";
import { nextEmailChangeStep, type EmailChangeStep } from "../lib/email-change-flow";
import { authClient } from "../lib/auth-client";
import { mapAuthError, normalizeOtp } from "../lib/two-factor";

export interface EmailChangeFlowProps {
  currentEmail: string;
  onSessionRefresh: () => Promise<unknown>;
}

type AuthError = { code?: string; message?: string } | null | undefined;

function emailError(error: AuthError, fallback: string) {
  if (error?.code === "CURRENT_EMAIL_OTP_ONLY") return "只能验证当前登录邮箱";
  if (error?.message === "Email already in use") return "该邮箱已被其他账户使用";
  return mapAuthError(error?.code, error?.message ?? fallback);
}

function OtpInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      id={id}
      value={value}
      onChange={(event) => onChange(normalizeOtp(event.target.value))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      required
      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm tracking-[0.25em] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
      placeholder="000000"
    />
  );
}

function FlowProgress({ step }: { step: EmailChangeStep }) {
  const stages = ["验证当前邮箱", "输入新邮箱", "验证新邮箱"];
  const activeIndex = step === "current-email" ? 0 : step === "new-email" ? 1 : 2;
  return (
    <ol className="mt-5 flex flex-col gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800 sm:flex-row sm:items-center sm:gap-3">
      {stages.map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-semibold ${index <= activeIndex ? "bg-blue-600 text-white" : "border border-blue-300 bg-white text-blue-700"}`}>{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export default function EmailChangeFlow({ currentEmail, onSessionRefresh }: EmailChangeFlowProps) {
  const [step, setStep] = useState<EmailChangeStep>("current-email");
  const [currentOtp, setCurrentOtp] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newEmailOtp, setNewEmailOtp] = useState("");
  const [currentOtpSent, setCurrentOtpSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const sendCurrentOtp = async () => {
    if (!currentEmail) {
      setError("无法读取当前登录邮箱，请重新登录后再试");
      return;
    }
    setError("");
    setLoading(true);
    const { error: authError } = await authClient.emailOtp.sendVerificationOtp({
      email: currentEmail,
      type: "email-verification",
    });
    setLoading(false);
    if (authError) {
      setError(emailError(authError, "验证码发送失败，请稍后重试"));
      return;
    }
    setCurrentOtpSent(true);
    setCurrentOtp("");
    setCooldown(60);
  };

  const verifyCurrentOtp = async (event: FormEvent) => {
    event.preventDefault();
    const otp = normalizeOtp(currentOtp);
    if (otp.length !== 6) {
      setError("请输入 6 位验证码");
      return;
    }
    setError("");
    setLoading(true);
    const { error: authError } = await authClient.emailOtp.checkVerificationOtp({
      email: currentEmail,
      type: "email-verification",
      otp,
    });
    setLoading(false);
    if (authError) {
      setError(emailError(authError, "当前邮箱验证码验证失败"));
      return;
    }
    setCurrentOtp(otp);
    setStep(nextEmailChangeStep(step, "current-otp-verified"));
  };

  const requestNewEmailOtp = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateNewEmail(currentEmail, newEmail);
    if (validation.error || validation.value === null) {
      setError(validation.error ?? "新邮箱不合法");
      return;
    }
    setError("");
    setLoading(true);
    const { error: authError } = await authClient.emailOtp.requestEmailChange({
      newEmail: validation.value,
      otp: currentOtp,
    });
    setLoading(false);
    if (authError) {
      setError(emailError(authError, "新邮箱验证码发送失败，请重新开始"));
      return;
    }
    setNewEmail(validation.value);
    setCurrentOtp("");
    setNewEmailOtp("");
    setCooldown(60);
    setStep(nextEmailChangeStep(step, "new-otp-sent"));
  };

  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    const otp = normalizeOtp(newEmailOtp);
    if (otp.length !== 6) {
      setError("请输入 6 位验证码");
      return;
    }
    setError("");
    setLoading(true);
    const { error: authError } = await authClient.emailOtp.changeEmail({ newEmail, otp });
    setLoading(false);
    if (authError) {
      setError(emailError(authError, "新邮箱验证码验证失败"));
      return;
    }
    await onSessionRefresh();
    setCurrentOtp("");
    setNewEmailOtp("");
    setStep(nextEmailChangeStep(step, "email-changed"));
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6">
      <Link to="/settings" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-blue-600">
        <span aria-hidden="true">←</span> 返回账户设置
      </Link>
      <h1 className="text-xl font-semibold text-gray-900">修改登录邮箱</h1>
      <p className="mt-1 text-sm text-gray-500">当前邮箱：{currentEmail || "—"}</p>
      <FlowProgress step={step} />
      {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}

      {step === "current-email" && (
        <section className="mt-5" aria-labelledby="verify-current-email-heading">
          <h2 id="verify-current-email-heading" className="text-base font-semibold text-gray-900">验证当前邮箱</h2>
          <p className="mt-1 text-sm text-gray-500">先向当前登录邮箱发送 6 位验证码。</p>
          {!currentOtpSent ? (
            <button type="button" onClick={() => void sendCurrentOtp()} disabled={loading} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400">{loading ? "发送中..." : "发送验证码"}</button>
          ) : (
            <form onSubmit={verifyCurrentOtp} className="mt-4 space-y-4">
              <div>
                <label htmlFor="current-email-otp" className="mb-1.5 block text-sm font-medium text-gray-700">当前邮箱验证码</label>
                <OtpInput id="current-email-otp" value={currentOtp} onChange={setCurrentOtp} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400">{loading ? "验证中..." : "验证并继续"}</button>
                <button type="button" disabled={loading || cooldown > 0} onClick={() => void sendCurrentOtp()} className="rounded-lg px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:text-gray-400">{cooldown > 0 ? `${cooldown} 秒后可重新发送` : "重新发送验证码"}</button>
              </div>
            </form>
          )}
        </section>
      )}

      {step === "new-email" && (
        <form onSubmit={requestNewEmailOtp} className="mt-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">输入新邮箱</h2>
            <p className="mt-1 text-sm text-gray-500">验证码会发送到新邮箱，完成验证后才会更新登录邮箱。</p>
          </div>
          <div>
            <label htmlFor="new-email" className="mb-1.5 block text-sm font-medium text-gray-700">新邮箱</label>
            <input id="new-email" type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} required autoComplete="email" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="请输入新邮箱" />
          </div>
          <button type="submit" disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400">{loading ? "发送中..." : "发送验证码"}</button>
        </form>
      )}

      {step === "new-email-otp" && (
        <form onSubmit={changeEmail} className="mt-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">验证新邮箱</h2>
            <p className="mt-1 text-sm text-gray-500">已向 {newEmail} 发送验证码。</p>
          </div>
          <div>
            <label htmlFor="new-email-otp" className="mb-1.5 block text-sm font-medium text-gray-700">新邮箱验证码</label>
            <OtpInput id="new-email-otp" value={newEmailOtp} onChange={setNewEmailOtp} />
          </div>
          <button type="submit" disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400">{loading ? "验证中..." : "确认更换邮箱"}</button>
          {cooldown > 0 && <p className="text-xs text-gray-500">验证码已发送；{cooldown} 秒内请勿重复请求。</p>}
        </form>
      )}

      {step === "complete" && <p className="mt-5 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700" role="status">登录邮箱已更新。</p>}
    </div>
  );
}
