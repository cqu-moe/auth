import { requestAuthentication } from "../lib/recent-authentication";
import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Alert, AlertDescription, Button, Input, Label } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import DeviceSessions from "./DeviceSessions";
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
    if (!await requestAuthentication("password")) { setLoading(false); return; }
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setLoading(false);

    if (error) {
      setFormError(error.message ?? "修改失败，请检查当前密码是否正确");
    } else {
      onSuccess();
    }
  };

  return (
    <form id="change-password-form" onSubmit={handleSubmit} className="mt-3 space-y-4 inline-editor rounded-lg p-4" noValidate>
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="field">
        <Label htmlFor="currentPassword">当前密码</Label>
        <Input
          id="currentPassword"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoComplete="current-password"
          autoFocus
        />
      </div>

      <div className="field">
        <Label htmlFor="newPassword">新密码</Label>
        <Input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.newPassword ? true : undefined}
          aria-describedby="new-password-hint"
          placeholder="至少 8 个字符"
        />
        {fieldErrors.newPassword ? (
          <p className="field-error" role="alert">{fieldErrors.newPassword}</p>
        ) : (
          <p id="new-password-hint" className="field-hint">至少 8 个字符，建议混合字母、数字和符号。</p>
        )}
      </div>

      <div className="field">
        <Label htmlFor="confirmNewPassword">确认新密码</Label>
        <Input
          id="confirmNewPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.confirm ? true : undefined}
        />
        {fieldErrors.confirm && (
          <p className="field-error" role="alert">{fieldErrors.confirm}</p>
        )}
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          取消
        </Button>
        <ActionButton
          type="submit"
          disabled={loading}
          state={loading ? "loading" : formError ? "error" : "idle"}
          labels={{
            idle: "修改密码",
            loading: "修改中…",
            success: "已修改",
            error: "重试修改",
          }}
        />
      </div>
    </form>
  );
}

export default function SecuritySection({ twoFactorEnabled }: SecuritySectionProps) {
  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  return (
    <SettingsCard title="安全设置">
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between gap-4 pb-4">
          <span className="w-16 shrink-0 text-sm text-muted-foreground">二次验证</span>
          <span className="min-w-0 flex-1">
            {twoFactorEnabled ? (
              <span className="badge badge-success"><i aria-hidden="true" />已启用</span>
            ) : (
              <span className="badge badge-muted"><i aria-hidden="true" />尚未启用</span>
            )}
          </span>
          <Button asChild variant="link" size="sm" aria-label="管理二次验证" className="shrink-0">
            <Link to="/settings/two-factor">{twoFactorEnabled ? "管理" : "设置"}</Link>
          </Button>
        </div>

        <div className="pt-4">
          <div className="flex items-center justify-between gap-4">
            <span className="w-16 shrink-0 text-sm text-muted-foreground">密码</span>
            <span className="min-w-0 flex-1 text-sm text-muted-foreground">定期更换密码可提升账户安全性。</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                setEditingPassword((v) => !v);
                setPasswordSuccess(false);
              }}
              aria-label="修改密码"
              aria-expanded={editingPassword}
              aria-controls="change-password-form"
              className="shrink-0"
            >
              修改
            </Button>
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
            <p className="mt-2 flex items-center justify-end gap-1 text-xs text-success" role="status">
              密码已更新
            </p>
          )}
        </div>
        <DeviceSessions />
      </div>
    </SettingsCard>
  );
}
