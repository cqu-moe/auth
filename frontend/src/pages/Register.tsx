import { useState, useEffect, FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { getPostAuthNavigationDestination } from "../lib/login-routing";
import {
  isExternalHttpTarget,
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { isScheduleBindingContinuation } from "../lib/cqu-bind-continuation";

function getPasswordStrength(password: string): { level: number; label: string; color: string } {
  if (!password) return { level: 0, label: "", color: "" };

  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { level: 1, label: "弱", color: "bg-red-500" };
  if (score <= 2) return { level: 2, label: "一般", color: "bg-yellow-500" };
  if (score <= 3) return { level: 3, label: "中等", color: "bg-blue-500" };
  return { level: 4, label: "强", color: "bg-green-500" };
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

  useEffect(() => {
    fetch("/api/auth/registration-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { invitationRequired?: boolean } | null) => {
        if (typeof data?.invitationRequired === "boolean") {
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
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">CQU Auth</h1>
          <p className="mt-2 text-gray-500">创建新账户</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <h2 className={`text-xl font-semibold text-gray-900 ${scheduleSource ? "mb-2" : "mb-6"}`}>注册</h2>
          {scheduleSource && (
            <p className="mb-6 text-sm text-gray-500">继续使用重庆大学课表</p>
          )}

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                昵称
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="您的昵称"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                邮箱
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                密码
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="至少 8 个字符"
              />
              {password && (
                <div className="mt-2">
                  <div className="flex gap-1 mb-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          i <= strength.level ? strength.color : "bg-gray-200"
                        }`}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">密码强度：{strength.label}</p>
                </div>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                确认密码
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                  confirmPassword && confirmPassword !== password
                    ? "border-red-300 bg-red-50"
                    : "border-gray-300"
                }`}
                placeholder="再次输入密码"
              />
              {confirmPassword && confirmPassword !== password && (
                <p className="mt-1 text-xs text-red-600">两次密码不一致</p>
              )}
            </div>

            <div>
              <label htmlFor="invitationCode" className="block text-sm font-medium text-gray-700 mb-1">
                邀请码
                {!invitationRequired && (
                  <span className="ml-2 text-xs font-normal text-gray-400">选填</span>
                )}
              </label>
              <input
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder={invitationRequired ? "请输入邀请码" : "请输入邀请码，可留空"}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 mt-2"
            >
              {loading && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {loading ? "注册中..." : "注册"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            已有账户？{" "}
            <Link
              to={withRedirectParam("/login", postLoginRedirect)}
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              立即登录
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
