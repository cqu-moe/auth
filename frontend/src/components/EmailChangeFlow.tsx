import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ActionButton, Alert, AlertDescription, Button, Input, Label, PageHeader } from "@cqu-moe/ui";
import { validateNewEmail } from "../lib/account-settings";
import { nextEmailChangeStep, restartEmailChangeFlow, type EmailChangeStep } from "../lib/email-change-flow";
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
    <Input
      id={id}
      value={value}
      onChange={(event) => onChange(normalizeOtp(event.target.value))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      required
      className="font-mono tracking-widest"
      placeholder="000000"
    />
  );
}

function FlowProgress({ step }: { step: EmailChangeStep }) {
  const stages = ["验证当前邮箱", "输入新邮箱", "验证新邮箱"];
  const activeIndex = step === "current-email" ? 0 : step === "new-email" ? 1 : 2;
  return (
    <ol className="mb-6 flex flex-col gap-3 border-b border-border pb-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:gap-4">
      {stages.map((label, index) => (
        <li key={label} className="flex items-center gap-2" aria-current={index === activeIndex ? "step" : undefined}>
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-semibold ${
              index <= activeIndex ? "bg-primary text-primary-foreground" : "border border-border bg-surface text-muted-foreground"
            }`}>{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function NewEmailOtpDeliveryNotice({
  newEmail,
  cooldown,
  onRestart,
}: {
  newEmail: string;
  cooldown: number;
  onRestart: () => void;
}) {
  return (
    <>
      <div>
        <h2 className="text-base font-semibold text-foreground">验证新邮箱</h2>
        <p className="mt-1 text-sm text-muted-foreground">若该地址可用，验证码已发送至 {newEmail}。</p>
      </div>
      {cooldown > 0 ? (
        <p className="text-xs text-muted-foreground">若该地址可用，验证码已发送；{cooldown} 秒内请勿重复请求。</p>
      ) : (
        <div className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
          <p>未收到新邮箱验证码？为保证安全，需要重新验证当前邮箱后才能再次发送。</p>
          <Button type="button" variant="link" size="sm" className="mt-1" onClick={onRestart}>
            重新验证当前邮箱
          </Button>
        </div>
      )}
    </>
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

  const restartCurrentEmailVerification = () => {
    const restarted = restartEmailChangeFlow(newEmail);
    setStep(restarted.step);
    setCurrentOtp(restarted.currentOtp);
    setCurrentOtpSent(restarted.currentOtpSent);
    setNewEmail(restarted.newEmail);
    setNewEmailOtp(restarted.newEmailOtp);
    setCooldown(restarted.cooldown);
    setError("");
  };

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="mb-5 -ml-2 text-muted-foreground">
        <Link to="/settings">
          <ArrowLeft aria-hidden="true" />
          返回账户设置
        </Link>
      </Button>
      <PageHeader title="修改登录邮箱" description={`当前邮箱：${currentEmail || "—"}`} />
      <FlowProgress step={step} />
      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {step === "current-email" && (
        <section className="content-panel" aria-labelledby="verify-current-email-heading">
          <h2 id="verify-current-email-heading" className="text-base font-semibold text-foreground">验证当前邮箱</h2>
          <p className="mt-1 text-sm text-muted-foreground">先向当前登录邮箱发送 6 位验证码。</p>
          {!currentOtpSent ? (
            <ActionButton
              type="button"
              className="mt-4"
              state={loading ? "loading" : error ? "error" : "idle"}
              onClick={() => void sendCurrentOtp()}
              labels={{ idle: "发送验证码", loading: "发送中…", success: "已发送", error: "重试发送" }}
            />
          ) : (
            <form onSubmit={verifyCurrentOtp} className="mt-4 space-y-4" noValidate>
              <div className="field">
                <Label htmlFor="current-email-otp">当前邮箱验证码</Label>
                <OtpInput id="current-email-otp" value={currentOtp} onChange={setCurrentOtp} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <ActionButton
                  type="submit"
                  disabled={loading}
                  state={loading ? "loading" : "idle"}
                  labels={{ idle: "验证并继续", loading: "验证中…", success: "已验证", error: "重试验证" }}
                />
                <Button
                  type="button"
                  variant="link"
                  disabled={loading || cooldown > 0}
                  onClick={() => void sendCurrentOtp()}
                >
                  {cooldown > 0 ? `${cooldown} 秒后可重新发送` : "重新发送验证码"}
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      {step === "new-email" && (
        <form onSubmit={requestNewEmailOtp} className="content-panel space-y-4" noValidate>
          <div>
            <h2 className="text-base font-semibold text-foreground">输入新邮箱</h2>
            <p className="mt-1 text-sm text-muted-foreground">验证码会发送到新邮箱，完成验证后才会更新登录邮箱。</p>
          </div>
          <div className="field">
            <Label htmlFor="new-email">新邮箱</Label>
            <Input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              required
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="email"
              placeholder="请输入新邮箱"
            />
          </div>
          <ActionButton
            type="submit"
            disabled={loading}
            state={loading ? "loading" : "idle"}
            labels={{ idle: "发送验证码", loading: "发送中…", success: "已发送", error: "重试发送" }}
          />
        </form>
      )}

      {step === "new-email-otp" && (
        <form onSubmit={changeEmail} className="content-panel space-y-4" noValidate>
          <NewEmailOtpDeliveryNotice
            newEmail={newEmail}
            cooldown={cooldown}
            onRestart={restartCurrentEmailVerification}
          />
          <div className="field">
            <Label htmlFor="new-email-otp">新邮箱验证码</Label>
            <OtpInput id="new-email-otp" value={newEmailOtp} onChange={setNewEmailOtp} />
          </div>
          <ActionButton
            type="submit"
            disabled={loading}
            state={loading ? "loading" : "idle"}
            labels={{ idle: "确认更换邮箱", loading: "更换中…", success: "已更换", error: "重试更换" }}
          />
        </form>
      )}

      {step === "complete" && (
        <p className="mt-5 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success" role="status">登录邮箱已更新。</p>
      )}
    </div>
  );
}
