import { useState, FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
          <p className="mt-2 text-gray-500">登录到您的账户</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <h2 className={`text-xl font-semibold text-gray-900 ${scheduleSource ? "mb-2" : "mb-6"}`}>登录</h2>
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
                autoComplete="current-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="输入密码"
              />
            </div>

            <div className="flex justify-end">
              <Link
                to={withRedirectParam("/reset-password", postLoginRedirect)}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                忘记密码？
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {loading ? "登录中..." : "登录"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            还没有账户？{" "}
            <Link
              to={withRedirectParam("/register", postLoginRedirect)}
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              立即注册
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
