import { useState, FormEvent } from "react";
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
  const confirmInvalid = Boolean(confirmPassword) && confirmPassword !== password;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    if (password.length < 8) {
      setError("密码至少需要 8 个字符");
      return;
    }

    if (!token) {
      setError("无效的重置链接，请重新申请");
      return;
    }

    setLoading(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);

    if (error) {
      setError(error.message ?? "重置失败，链接可能已过期");
    } else {
      navigate(withRedirectParam("/login", postLoginRedirect));
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
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            disabled={!token}
            placeholder="至少 8 个字符"
          />
        </div>

        <div className="field">
          <Label htmlFor="confirmPassword">确认新密码</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            disabled={!token}
            aria-invalid={confirmInvalid || undefined}
            aria-describedby={confirmInvalid ? "confirm-password-error" : undefined}
            placeholder="再次输入新密码"
          />
          {confirmInvalid && (
            <p id="confirm-password-error" className="field-error" role="alert">
              两次密码不一致
            </p>
          )}
        </div>

        <ActionButton
          type="submit"
          className="w-full"
          disabled={!token}
          state={loading ? "loading" : error ? "error" : "idle"}
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
