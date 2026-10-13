import { useState, FormEvent, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ActionButton, Alert, AlertDescription, AlertTitle, Input, Label } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import { authClient } from "../lib/auth-client";
import { sanitizePostLoginRedirect, withRedirectParam } from "../lib/post-login-redirect";

export default function ResetPasswordConfirm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    setError("");
    const nextFieldErrors: typeof fieldErrors = {};
    if (password.length < 8) nextFieldErrors.password = "密码至少需要 8 个字符";
    if (password !== confirmPassword) nextFieldErrors.confirm = "两次输入的密码不一致";
    setFieldErrors(nextFieldErrors);

    if (nextFieldErrors.password) {
      passwordRef.current?.focus();
      return;
    } else if (nextFieldErrors.confirm) {
      confirmPasswordRef.current?.focus();
      return;
    }

    if (!token) {
      setError("无效的重置链接，请重新申请");
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      const { error } = await authClient.resetPassword({ newPassword: password, token });

      if (error) {
        setError(error.message ?? "重置失败，链接可能已过期");
      } else {
        navigate(withRedirectParam("/login", postLoginRedirect));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="设置新密码" description="为你的账户设置新的登录密码。">
      {!token && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>链接无效</AlertTitle>
          <AlertDescription>无效的重置链接，请重新申请重置密码。</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="field">
          <Label htmlFor="password">新密码</Label>
          <Input
            id="password"
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password && e.target.value.length >= 8) {
                setFieldErrors((errors) => ({ ...errors, password: undefined }));
              }
              if (fieldErrors.confirm && e.target.value === confirmPassword) {
                setFieldErrors((errors) => ({ ...errors, confirm: undefined }));
              }
            }}
            onBlur={() => {
              if (password.length < 8) {
                setFieldErrors((errors) => ({ ...errors, password: "密码至少需要 8 个字符" }));
              }
            }}
            required
            autoComplete="new-password"
            disabled={!token}
            placeholder="至少 8 个字符"
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? "password-error" : undefined}
          />
          {fieldErrors.password && (
            <p id="password-error" className="field-error" role="alert">
              {fieldErrors.password}
            </p>
          )}
        </div>

        <div className="field">
          <Label htmlFor="confirmPassword">确认新密码</Label>
          <Input
            id="confirmPassword"
            ref={confirmPasswordRef}
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (fieldErrors.confirm && e.target.value === password) {
                setFieldErrors((errors) => ({ ...errors, confirm: undefined }));
              }
            }}
            onBlur={() => {
              if (confirmPassword !== password) {
                setFieldErrors((errors) => ({ ...errors, confirm: "两次输入的密码不一致" }));
              }
            }}
            required
            autoComplete="new-password"
            disabled={!token}
            aria-invalid={fieldErrors.confirm ? true : undefined}
            aria-describedby={fieldErrors.confirm ? "confirm-password-error" : undefined}
            placeholder="再次输入新密码"
          />
          {fieldErrors.confirm && (
            <p id="confirm-password-error" className="field-error" role="alert">
              {fieldErrors.confirm}
            </p>
          )}
        </div>

        <ActionButton
          type="submit"
          className="w-full"
          disabled={!token}
          state={
            loading ? "loading" : error || Object.values(fieldErrors).some(Boolean) ? "error" : "idle"
          }
          labels={{
            idle: "重置密码",
            loading: "重置中…",
            success: "已重置",
            error: "重试重置",
          }}
        />
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link
          to={withRedirectParam("/reset-password", postLoginRedirect)}
          className="font-medium text-link hover:underline"
        >
          重新发送重置链接
        </Link>
      </p>
    </AuthLayout>
  );
}
