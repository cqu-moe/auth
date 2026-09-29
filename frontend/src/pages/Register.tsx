import { useState, useEffect, FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ActionButton, Alert, AlertDescription, Input, Label } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import { authClient } from "../lib/auth-client";
import { getPostAuthNavigationDestination } from "../lib/login-routing";
import {
  isExternalHttpTarget,
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { isScheduleBindingContinuation } from "../lib/cqu-bind-continuation";
import { getRegistrationSettings } from "../lib/api/registration";

function getPasswordStrength(password: string): { level: number; label: string; bar: string } {
  if (!password) return { level: 0, label: "", bar: "" };

  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { level: 1, label: "弱", bar: "bg-destructive" };
  if (score <= 2) return { level: 2, label: "一般", bar: "bg-warning" };
  if (score <= 3) return { level: 3, label: "中等", bar: "bg-link" };
  return { level: 4, label: "强", bar: "bg-success" };
}

export default function Register() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const postLoginRedirect = sanitizePostLoginRedirect(searchParams.get("redirect"));
  const scheduleSource = isScheduleBindingContinuation(postLoginRedirect, window.location.origin);
  const [code, setCode] = useState(() =>
    (searchParams.get("code") ?? "").trim().toUpperCase().slice(0, 8)
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const strength = getPasswordStrength(password);
  // 邀请码是否必填由管理台「注册政策」控制;默认按必填渲染(与后端缺省一致),
  // 拉到设置后再放宽为选填。
  const [invitationRequired, setInvitationRequired] = useState(true);
  const confirmInvalid = Boolean(confirmPassword) && confirmPassword !== password;

  useEffect(() => {
    getRegistrationSettings()
      .then((data) => {
        if (typeof data.invitationRequired === "boolean") {
          setInvitationRequired(data.invitationRequired);
        }
      })
      .catch(() => {
        // 拉不到设置就维持必填(后端缺省同样要求邀请码,行为一致)。
      });
  }, []);

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

    setLoading(true);
    const signup = {
      email,
      password,
      name,
      code,
    } as Parameters<
      typeof authClient.signUp.email
    >[0] & { code: string };
    const { data, error } = await authClient.signUp.email(signup);
    setLoading(false);

    if (error) {
      setError(error.message ?? "注册失败，请稍后重试");
    } else {
      const destination = getPostAuthNavigationDestination(
        data?.user.emailVerified === true,
        postLoginRedirect
      );
      if (isExternalHttpTarget(destination)) {
        window.location.assign(destination);
        return;
      }
      navigate(destination, { replace: true });
    }
  };

  return (
    <AuthLayout
      title="创建账号"
      description={scheduleSource ? "继续使用重庆大学课表" : "一个账号，连接你的校园服务。"}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="field">
          <Label htmlFor="name">昵称</Label>
          <Input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
            placeholder="您的昵称"
          />
        </div>

        <div className="field">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            placeholder="your@email.com"
          />
        </div>

        <div className="field">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="至少 8 个字符"
          />
          {password && (
            <div>
              <div className="flex gap-1" aria-hidden="true">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-colors ${
                      i <= strength.level ? strength.bar : "bg-muted"
                    }`}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">密码强度：{strength.label}</p>
            </div>
          )}
        </div>

        <div className="field">
          <Label htmlFor="confirmPassword">确认密码</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            aria-invalid={confirmInvalid || undefined}
            aria-describedby={confirmInvalid ? "confirm-password-error" : undefined}
            placeholder="再次输入密码"
          />
          {confirmInvalid && (
            <p id="confirm-password-error" className="field-error" role="alert">
              两次密码不一致
            </p>
          )}
        </div>

        <div className="field">
          <Label htmlFor="invitationCode">
            邀请码
            {!invitationRequired && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">选填</span>
            )}
          </Label>
          <Input
            id="invitationCode"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.trim().toUpperCase().slice(0, 8))}
            required={invitationRequired}
            minLength={invitationRequired ? 8 : 0}
            maxLength={8}
            pattern={invitationRequired ? "[A-HJ-NP-Z2-9]{8}" : "([A-HJ-NP-Z2-9]{8})?"}
            autoComplete="one-time-code"
            spellCheck={false}
            className="font-mono tracking-widest uppercase"
            placeholder={invitationRequired ? "请输入邀请码" : "请输入邀请码，可留空"}
          />
        </div>

        <ActionButton
          type="submit"
          className="w-full"
          state={loading ? "loading" : error ? "error" : "idle"}
          labels={{
            idle: "注册",
            loading: "注册中…",
            success: "已注册",
            error: "重试注册",
          }}
        />
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        已有账户？{" "}
        <Link
          to={withRedirectParam("/login", postLoginRedirect)}
          className="font-medium text-link hover:underline"
        >
          立即登录
        </Link>
      </p>
    </AuthLayout>
  );
}
