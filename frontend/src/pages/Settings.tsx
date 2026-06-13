import { useState, FormEvent, useEffect } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import Layout from "../components/Layout";

// DO /status 返回的会话状态对象（active/relogin_required/... + studentId）；
// 后端在 DO 非 2xx 或解析失败时回传 { error: true } sentinel。
interface CquSessionStatus {
  status?: string;
  studentId?: string;
  error?: boolean;
}

// GET /api/cqu/bind/status 的响应形状。
interface CquBindStatus {
  address?: string;
  bindStatus: "pending" | "active" | "revoked" | "unbound";
  sessionStatus: CquSessionStatus;
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }

    if (newPassword.length < 8) {
      setError("新密码至少需要 8 个字符");
      return;
    }

    setLoading(true);
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: false,
    });
    setLoading(false);

    if (error) {
      setError(error.message ?? "修改失败，请检查当前密码是否正确");
    } else {
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">修改密码</h3>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          密码已成功修改
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700 mb-1">
            当前密码
          </label>
          <input
            id="currentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div>
          <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
            新密码
          </label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="至少 8 个字符"
          />
        </div>

        <div>
          <label htmlFor="confirmNewPassword" className="block text-sm font-medium text-gray-700 mb-1">
            确认新密码
          </label>
          <input
            id="confirmNewPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          {loading && (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {loading ? "保存中..." : "保存修改"}
        </button>
      </form>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时静默失败，地址仍可手动选中复制。
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors flex-shrink-0"
      aria-label="复制到剪贴板"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function CquBindingSection() {
  const [status, setStatus] = useState<CquBindStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [unbindLoading, setUnbindLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fetchStatus = async () => {
    setStatusLoading(true);
    try {
      const res = await fetch("/api/cqu/bind/status", { credentials: "include" });
      if (res.ok) {
        const data = await res.json() as CquBindStatus;
        setStatus(data);
      }
    } catch {
      // ignore
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  const handleUnbind = async () => {
    if (!confirm("确认解除 CQU 账户绑定？解绑后将无法通过本系统访问重庆大学相关服务。")) return;
    setError("");
    setSuccess("");
    setUnbindLoading(true);

    try {
      const res = await fetch("/api/cqu/bind/unbind", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setSuccess("已成功解除 CQU 账户绑定");
        await fetchStatus();
      } else {
        const data = await res.json().catch(() => ({})) as {
          detail?: { error?: { message?: string } };
        };
        setError(data.detail?.error?.message ?? "解绑失败，请稍后重试");
      }
    } catch {
      setError("请求失败，请稍后重试");
    } finally {
      setUnbindLoading(false);
    }
  };

  if (statusLoading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">CQU 账户绑定</h3>
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <div className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          加载中...
        </div>
      </div>
    );
  }

  const isBound = status != null && status.bindStatus !== "unbound";
  const sessionActive = status?.sessionStatus?.status === "active";
  const studentId = status?.sessionStatus?.studentId;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">CQU 账户绑定</h3>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      {isBound ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 p-4 bg-gray-50 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">学号</span>
              <span className="text-sm font-medium text-gray-900">{studentId ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">会话状态</span>
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                sessionActive
                  ? "bg-green-100 text-green-700"
                  : "bg-yellow-100 text-yellow-700"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  sessionActive ? "bg-green-500" : "bg-yellow-500"
                }`} />
                {sessionActive ? "正常" : "需要重新登录"}
              </span>
            </div>
            {status?.address && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-500 flex-shrink-0">专属邮箱</span>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-gray-900 truncate">{status.address}</span>
                  <CopyButton text={status.address} />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/cqu/bind"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              绑定新账号
            </Link>
            <button
              onClick={handleUnbind}
              disabled={unbindLoading}
              className="px-4 py-2 border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
            >
              {unbindLoading && (
                <span className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
              )}
              {unbindLoading ? "解绑中..." : "解除绑定"}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-sm text-gray-500 mb-4">
            绑定 CQU 账户后，您可以通过本系统访问重庆大学相关服务。
          </p>
          <Link
            to="/cqu/bind"
            className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            绑定 CQU 账户
          </Link>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { data: session } = authClient.useSession();
  const user = session?.user as { email?: string; name?: string; createdAt?: string } | undefined;

  return (
    <Layout>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">账户设置</h1>

        <div className="space-y-6">
          {/* 个人信息 */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-4">个人信息</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <span className="text-sm text-gray-500">昵称</span>
                <span className="text-sm font-medium text-gray-900">{user?.name ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-gray-500">邮箱</span>
                <span className="text-sm font-medium text-gray-900">{user?.email ?? "—"}</span>
              </div>
            </div>
          </div>

          {/* 修改密码 */}
          <ChangePasswordSection />

          {/* CQU 绑定 */}
          <CquBindingSection />
        </div>
      </div>
    </Layout>
  );
}
