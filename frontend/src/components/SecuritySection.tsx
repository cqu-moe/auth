import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import SettingsCard from "./SettingsCard";

interface SecuritySectionProps {
  twoFactorEnabled: boolean;
}

function ChangePasswordEditor({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ newPassword?: string; confirm?: string }>({});
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");
    setFieldErrors({});

    if (newPassword.length < 8) {
      setFieldErrors({ newPassword: "新密码至少需要 8 个字符" });
      return;
    }

    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirm: "两次输入的新密码不一致" });
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
      setFormError(error.message ?? "修改失败，请检查当前密码是否正确");
    } else {
      onSuccess();
    }
  };

  const inputClass = (invalid?: string) =>
    `w-full rounded-lg border bg-white px-3 py-2 text-base focus:outline-none focus:ring-2 sm:text-sm ${
      invalid
        ? "border-red-300 focus:ring-red-500"
        : "border-gray-300 focus:ring-blue-500"
    }`;

  return (
    <form id="change-password-form" onSubmit={handleSubmit} className="mt-3 space-y-4 rounded-xl bg-gray-50 p-4">
      {formError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {formError}
        </div>
      )}

      <div>
        <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium text-gray-700">
          当前密码
        </label>
        <input
          id="currentPassword"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoComplete="current-password"
          autoFocus
          className={inputClass()}
        />
      </div>

      <div>
        <label htmlFor="newPassword" className="mb-1 block text-sm font-medium text-gray-700">
          新密码
        </label>
        <input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.newPassword ? true : undefined}
          aria-describedby="new-password-hint"
          className={inputClass(fieldErrors.newPassword)}
          placeholder="至少 8 个字符"
        />
        {fieldErrors.newPassword ? (
          <p className="mt-1.5 text-sm text-red-700" role="alert">{fieldErrors.newPassword}</p>
        ) : (
          <p id="new-password-hint" className="mt-1.5 text-xs text-gray-400">至少 8 个字符，建议混合字母、数字和符号。</p>
        )}
      </div>

      <div>
        <label htmlFor="confirmNewPassword" className="mb-1 block text-sm font-medium text-gray-700">
          确认新密码
        </label>
        <input
          id="confirmNewPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.confirm ? true : undefined}
          className={inputClass(fieldErrors.confirm)}
        />
        {fieldErrors.confirm && (
          <p className="mt-1.5 text-sm text-red-700" role="alert">{fieldErrors.confirm}</p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-700 active:scale-[0.98] disabled:bg-blue-400"
        >
          {loading && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {loading ? "修改中..." : "修改密码"}
        </button>
      </div>
    </form>
  );
}

export default function SecuritySection({ twoFactorEnabled }: SecuritySectionProps) {
  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  return (
    <SettingsCard title="安全设置" description="二次验证与登录密码。">
      <div className="divide-y divide-gray-100">
        <div className="flex items-center justify-between gap-4 pb-4">
          <span className="w-16 shrink-0 text-sm text-gray-500">二次验证</span>
          <span className="min-w-0 flex-1">
            {twoFactorEnabled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />
                已启用
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-400" aria-hidden="true" />
                尚未启用
              </span>
            )}
          </span>
          <Link
            to="/settings/two-factor"
            aria-label="管理二次验证"
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          >
            {twoFactorEnabled ? "管理" : "设置"}
          </Link>
        </div>

        <div className="pt-4">
          <div className="flex items-center justify-between gap-4">
            <span className="w-16 shrink-0 text-sm text-gray-500">密码</span>
            <span className="min-w-0 flex-1 text-sm text-gray-500">定期更换密码可提升账户安全性。</span>
            <button
              type="button"
              onClick={() => {
                setEditingPassword((v) => !v);
                setPasswordSuccess(false);
              }}
              aria-label="修改密码"
              aria-expanded={editingPassword}
              aria-controls="change-password-form"
              className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
            >
              修改
            </button>
          </div>

          {editingPassword && (
            <ChangePasswordEditor
              onCancel={() => setEditingPassword(false)}
              onSuccess={() => {
                setEditingPassword(false);
                setPasswordSuccess(true);
              }}
            />
          )}

          {passwordSuccess && !editingPassword && (
            <p className="mt-2 flex items-center justify-end gap-1 text-xs text-green-700" role="status">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              密码已更新
            </p>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}
