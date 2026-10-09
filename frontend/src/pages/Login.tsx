import { useState, FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ActionButton, Button, Alert, AlertDescription, Input, Label } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import { authClient } from "../lib/auth-client";
import { getLoginNavigationDestination } from "../lib/login-routing";
import {
  isExternalHttpTarget,
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { isScheduleBindingContinuation } from "../lib/cqu-bind-continuation";

export default function Login() {
  const navigate = useNavigate();
  const { refetch: refetchSession } = authClient.useSession();
  const [searchParams] = useSearchParams();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const scheduleSource = isScheduleBindingContinuation(postLoginRedirect, window.location.origin);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { data, error } = await authClient.signIn.email({ email, password });

    setLoading(false);

    if (error) {
      setError(error.message ?? "登录失败，请检查邮箱和密码");
    } else {
      const destination = getLoginNavigationDestination(data, postLoginRedirect);
      if (!destination) return;
      await refetchSession();
      if (isExternalHttpTarget(destination)) {
        window.location.assign(destination);
        return;
      }
      navigate(destination, { replace: true });
    }
  };

  const loginWithPasskey = async () => {
    setLoading(true); setError("");
    try {
      const { data, error } = await authClient.signIn.passkey();
      if (error) { setError("Passkey 登录未完成，请重试或使用密码登录"); return; }
      await refetchSession();
      const destination = getLoginNavigationDestination(data, postLoginRedirect);
      if (!destination) return;
      if (isExternalHttpTarget(destination)) window.location.assign(destination);
      else navigate(destination, { replace: true });
    } catch { setError("Passkey 登录未完成，请重试"); }
    finally { setLoading(false); }
  };

  return (
    <AuthLayout
      title="欢迎回来"
      description={scheduleSource ? "继续使用重庆大学课表" : "登录你的账户，继续使用校园服务。"}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="field">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="your@email.com"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
          />
        </div>

        <div className="field">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">密码</Label>
            <Link
              to={withRedirectParam("/reset-password", postLoginRedirect)}
              className="text-sm text-link hover:underline"
            >
              忘记密码？
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="输入密码"
          />
        </div>

        <ActionButton
          type="submit"
          className="w-full"
          state={loading ? "loading" : error ? "error" : "idle"}
          labels={{
            idle: "登录",
            loading: "登录中…",
            success: "已登录",
            error: "重试登录",
          }}
        />
      </form>
      <Button type="button" variant="outline" className="mt-3 w-full" disabled={loading} onClick={() => void loginWithPasskey()}>使用 Passkey 登录</Button>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        还没有账户？{" "}
        <Link
          to={withRedirectParam("/register", postLoginRedirect)}
          className="font-medium text-link hover:underline"
        >
          立即注册
        </Link>
      </p>
    </AuthLayout>
  );
}
