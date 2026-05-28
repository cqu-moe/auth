import { useState, FormEvent, useEffect } from "react";
import { authClient } from "../lib/auth-client";
import Layout from "../components/Layout";

interface CquStatus {
  bound: boolean;
  studentId?: string;
  sessionStatus?: string;
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

function CquBindForm({
  onSubmit,
  loading,
  isRebind,
  onCancel,
}: {
  onSubmit: (studentId: string, password: string) => void;
  loading: boolean;
  isRebind: boolean;
  onCancel?: () => void;
}) {
  const [studentId, setStudentId] = useState("");
  const [cquPassword, setCquPassword] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(studentId, cquPassword);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="studentId" className="block text-sm font-medium text-gray-700 mb-1">
          学号
        </label>
        <input
          id="studentId"
          type="text"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          required
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="输入您的学号"
        />
      </div>

      <div>
        <label htmlFor="cquPassword" className="block text-sm font-medium text-gray-700 mb-1">
          CQU 统一认证密码
        </label>
        <input
          id="cquPassword"
          type="password"
          value={cquPassword}
          onChange={(e) => setCquPassword(e.target.value)}
          required
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="输入 CQU 统一认证密码"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          {loading && (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {loading ? "绑定中..." : isRebind ? "确认换绑" : "绑定账户"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium rounded-lg transition-colors"
          >
            取消
          </button>
        )}
      </div>
    </form>
  );
}

function CquBindingSection() {
  const [status, setStatus] = useState<CquStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [showRebindForm, setShowRebindForm] = useState(false);
  const [bindLoading, setBindLoading] = useState(false);
  const [unbindLoading, setUnbindLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fetchStatus = async () => {
    setStatusLoading(true);
    try {
      const res = await fetch("/api/cqu/status");
      if (res.ok) {
        const data = await res.json() as CquStatus;
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

  const handleBind = async (studentId: string, password: string) => {
    setError("");
    setSuccess("");
    setBindLoading(true);

    const isRebind = status?.bound;
    try {
      const res = await fetch("/api/cqu/bind", {
        method: isRebind ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, password }),
      });

      if (res.ok) {
        setSuccess(isRebind ? "已成功换绑新 CQU 账户" : "CQU 账户绑定成功");
        setShowRebindForm(false);
        await fetchStatus();
      } else {
        const data = await res.json() as { message?: string };
        setError(data.message ?? "绑定失败，请检查学号和密码");
      }
    } catch {
      setError("请求失败，请稍后重试");
    } finally {
      setBindLoading(false);
    }
  };

  const handleUnbind = async () => {
    if (!confirm("确认解除 CQU 账户绑定？解绑后将无法通过本系统访问重庆大学相关服务。")) return;
    setError("");
    setSuccess("");
    setUnbindLoading(true);

    try {
      const res = await fetch("/api/cqu/bind", { method: "DELETE" });
      if (res.ok) {
        setSuccess("已成功解除 CQU 账户绑定");
        setShowRebindForm(false);
        await fetchStatus();
      } else {
        const data = await res.json() as { message?: string };
        setError(data.message ?? "解绑失败，请稍后重试");
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

      {status?.bound ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 p-4 bg-gray-50 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">学号</span>
              <span className="text-sm font-medium text-gray-900">{status.studentId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">会话状态</span>
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                status.sessionStatus === "active"
                  ? "bg-green-100 text-green-700"
                  : "bg-yellow-100 text-yellow-700"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  status.sessionStatus === "active" ? "bg-green-500" : "bg-yellow-500"
                }`} />
                {status.sessionStatus === "active" ? "正常" : "需要重新登录"}
              </span>
            </div>
          </div>

          {showRebindForm ? (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-sm text-gray-500 mb-4">
                输入新的 CQU 账号信息，换绑失败不会影响当前绑定。
              </p>
              <CquBindForm
                onSubmit={handleBind}
                loading={bindLoading}
                isRebind
                onCancel={() => { setShowRebindForm(false); setError(""); }}
              />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setShowRebindForm(true); setError(""); setSuccess(""); }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                绑定新账号
              </button>
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
          )}
        </div>
      ) : (
        <div>
          <p className="text-sm text-gray-500 mb-4">
            绑定 CQU 账户后，您可以通过本系统访问重庆大学相关服务。
          </p>
          <CquBindForm onSubmit={handleBind} loading={bindLoading} isRebind={false} />
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
