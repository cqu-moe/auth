import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, Mail } from "lucide-react";
import { ActionButton, Button, Input, Label } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
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
    <AuthLayout title="输入邮箱验证码" description="最后一步：验证你的邮箱地址。">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Mail aria-hidden="true" size={20} />
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          输入发送至以下邮箱的 6 位验证码。验证码 5 分钟内有效。
          <span className="mt-1 block break-all font-medium text-foreground">
            {user?.email ?? "当前登录邮箱"}
          </span>
        </p>
      </div>

      <form onSubmit={handleVerify} className="space-y-4" aria-busy={verifying} noValidate>
        <div className="field">
          <Label htmlFor="email-verification-otp">六位验证码</Label>
          <Input
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
            aria-describedby={
              verificationError ? "email-verification-error" : "email-verification-help"
            }
            data-lpignore="true"
            data-1p-ignore
            className="otp-input"
            placeholder="000000"
          />
          {!verificationError && (
            <p id="email-verification-help" className="field-hint">
              仅输入邮件中的数字
            </p>
          )}
          {verificationError && (
            <p id="email-verification-error" className="field-error" role="alert">
              <AlertCircle aria-hidden="true" />
              {verificationError}
            </p>
          )}
        </div>

        <ActionButton
          type="submit"
          className="w-full"
          disabled={sendStatus === "sending"}
          state={verifying ? "loading" : verificationError ? "error" : "idle"}
          labels={{
            idle: "验证并继续",
            loading: "验证中…",
            success: "已验证",
            error: "重新验证",
          }}
        />
      </form>

      <div className="mt-5 flex min-h-11 items-center justify-center gap-1 text-sm text-muted-foreground">
        <span>没有收到？</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => void handleResend()}
          disabled={sendStatus === "sending" || verifying}
        >
          {sendStatus === "sending" ? "发送中…" : "重新发送验证码"}
        </Button>
      </div>

      <div className="min-h-5 text-center text-sm" aria-live="polite">
        {sendStatus === "sent" && (
          <p className="text-success">新验证码已发送，请检查收件箱。</p>
        )}
        {sendStatus === "error" && (
          <p className="text-destructive" role="alert">{sendError}</p>
        )}
      </div>

      <div className="mt-5 border-t border-border pt-3 text-center">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleSignOut()}
          disabled={verifying || sendStatus === "sending"}
        >
          退出当前账户
        </Button>
      </div>
    </AuthLayout>
  );
}
