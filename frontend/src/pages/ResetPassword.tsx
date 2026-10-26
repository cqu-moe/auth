import { TURNSTILE_TOKEN_HEADER } from "../../../shared/turnstile";
import { useTurnstile } from "../lib/use-turnstile";
import TurnstileVerification from "../components/TurnstileVerification";
import { useState, FormEvent, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MailCheck } from "lucide-react";
import { ActionButton, Alert, AlertDescription, Button, Input, Label } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import { authClient } from "../lib/auth-client";
import { sanitizePostLoginRedirect, withRedirectParam } from "../lib/post-login-redirect";

export default function ResetPassword() {
  const verification = useTurnstile("password-reset");
  const [searchParams] = useSearchParams();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    setError("");
    if (!emailRef.current?.validity.valid) {
      setEmailError("请输入有效的邮箱地址");
      emailRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    let verificationToken: string | null = null;
    try {
      verificationToken = await verification.getToken();
      if (!verificationToken) return;
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: withRedirectParam("/reset-password/confirm", postLoginRedirect),
      }, { headers: { [TURNSTILE_TOKEN_HEADER]: verificationToken } });

      if (error) {
        setError(error.message ?? "发送失败，请稍后重试");
      } else {
        setSent(true);
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      if (verificationToken) verification.reset();
      submittingRef.current = false;
      setLoading(false);
    }
  };


  if (sent) {
    return (
      <AuthLayout title="邮件已发送" description="请查收并点击邮件中的链接重置密码。">
        <div className="text-center">
          <MailCheck aria-hidden="true" className="mx-auto mb-4 text-muted-foreground" size={32} />
          <p className="text-sm text-muted-foreground">
            重置密码链接已发送到 <span className="font-medium text-foreground">{email}</span>
            ，请查收并点击链接重置密码。
          </p>
          <Button asChild variant="link" className="mt-4">
            <Link to={withRedirectParam("/login", postLoginRedirect)}>返回登录</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="重置你的密码" description="输入注册邮箱，我们将发送重置密码链接。">
      <form onSubmit={handleSubmit} className="space-y-4" aria-busy={loading} noValidate>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="field">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            ref={emailRef}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError && e.target.validity.valid) setEmailError("");
            }}
            onBlur={() => {
              if (!emailRef.current?.validity.valid) setEmailError("请输入有效的邮箱地址");
            }}
            readOnly={loading}
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            placeholder="your@email.com"
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "email-error" : undefined}
          />
          {emailError && (
            <p id="email-error" className="field-error" role="alert">
              {emailError}
            </p>
          )}
        </div>

        <TurnstileVerification verification={verification} />
        <ActionButton
          type="submit"
          className="w-full"
          state={loading ? "loading" : error || emailError || verification.status === "error" ? "error" : "idle"}
          labels={{
            idle: "发送重置链接",
            loading: verification.waiting ? "正在完成安全验证…" : "发送中…",
            success: "已发送",
            error: "重试发送",
          }}
        />
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        想起密码了？{" "}
        <Link
          to={withRedirectParam("/login", postLoginRedirect)}
          className="font-medium text-link hover:underline"
        >
          返回登录
        </Link>
      </p>
    </AuthLayout>
  );
}
