import AuthenticationMethodChoice, { type AuthenticationMethod } from "./AuthenticationMethodChoice";
import { passkeyAccountOperation } from "../lib/passkey-operations";
import { requestAuthentication } from "../lib/recent-authentication";
import { FormEvent, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Alert, AlertDescription, Button, Input, Label } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import DeviceSessions from "./DeviceSessions";
import SettingsCard from "./SettingsCard";

interface SecuritySectionProps {
  twoFactorEnabled: boolean;
}

function ChangePasswordEditor({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void }) {
  const [method, setMethod] = useState<AuthenticationMethod>("password");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    currentPassword?: string;
    newPassword?: string;
    confirm?: string;
  }>({});
  const [loading, setLoading] = useState(false);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    setFormError("");
    const nextFieldErrors: typeof fieldErrors = {};
    if (method === "password" && !currentPassword) {
      nextFieldErrors.currentPassword = "请输入当前密码";
    }
    if (newPassword.length < 8) nextFieldErrors.newPassword = "新密码至少需要 8 个字符";
    if (newPassword !== confirmPassword) nextFieldErrors.confirm = "两次输入的新密码不一致";
    setFieldErrors(nextFieldErrors);

    if (nextFieldErrors.currentPassword) {
      currentPasswordRef.current?.focus();
      return;
    } else if (nextFieldErrors.newPassword) {
      newPasswordRef.current?.focus();
      return;
    } else if (nextFieldErrors.confirm) {
      confirmPasswordRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      if (method === "password" && !(await requestAuthentication("password", currentPassword))) {
        return;
      }
      const { error } = method === "passkey"
        ? await passkeyAccountOperation("change-password", { newPassword })
        : await authClient.changePassword({
            currentPassword,
            newPassword,
            revokeOtherSessions: true,
          });

      if (error) {
        setFormError(error.message ?? "修改失败，请检查当前密码是否正确");
      } else {
        onSuccess();
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "网络错误，请重试");
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <form id="change-password-form" onSubmit={handleSubmit} className="mt-3 space-y-4 inline-editor rounded-lg p-4" noValidate>
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <AuthenticationMethodChoice value={method} onChange={setMethod} disabled={loading} />
      {method === "password" && <div className="field">
        <Label htmlFor="currentPassword">当前密码</Label>
        <Input
          id="currentPassword"
            ref={currentPasswordRef}
          type="password"
          value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              if (fieldErrors.currentPassword && e.target.value) {
                setFieldErrors((errors) => ({ ...errors, currentPassword: undefined }));
              }
            }}
            onBlur={() => {
              if (!currentPassword) {
                setFieldErrors((errors) => ({ ...errors, currentPassword: "请输入当前密码" }));
              }
            }}
          required
          autoComplete="current-password"
          autoFocus
            aria-invalid={fieldErrors.currentPassword ? true : undefined}
            aria-describedby={fieldErrors.currentPassword ? "current-password-error" : undefined}
        />
          {fieldErrors.currentPassword && (
            <p id="current-password-error" className="field-error" role="alert">
              {fieldErrors.currentPassword}
            </p>
          )}
      </div>}

      <div className="field">
        <Label htmlFor="newPassword">新密码</Label>
        <Input
          id="newPassword"
            ref={newPasswordRef}
          type="password"
          value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              if (fieldErrors.newPassword && e.target.value.length >= 8) {
                setFieldErrors((errors) => ({ ...errors, newPassword: undefined }));
              }
              if (fieldErrors.confirm && e.target.value === confirmPassword) {
                setFieldErrors((errors) => ({ ...errors, confirm: undefined }));
              }
            }}
            onBlur={() => {
              if (newPassword.length < 8) {
                setFieldErrors((errors) => ({ ...errors, newPassword: "新密码至少需要 8 个字符" }));
              }
            }}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.newPassword ? true : undefined}
            aria-describedby={fieldErrors.newPassword ? "new-password-error" : "new-password-hint"}
          placeholder="至少 8 个字符"
        />
        {fieldErrors.newPassword ? (
          <p id="new-password-error" className="field-error" role="alert">{fieldErrors.newPassword}</p>
        ) : (
          <p id="new-password-hint" className="field-hint">至少 8 个字符，建议混合字母、数字和符号。</p>
        )}
      </div>

      <div className="field">
        <Label htmlFor="confirmNewPassword">确认新密码</Label>
        <Input
          id="confirmNewPassword"
            ref={confirmPasswordRef}
          type="password"
          value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (fieldErrors.confirm && e.target.value === newPassword) {
                setFieldErrors((errors) => ({ ...errors, confirm: undefined }));
              }
            }}
            onBlur={() => {
              if (confirmPassword !== newPassword) {
                setFieldErrors((errors) => ({ ...errors, confirm: "两次输入的新密码不一致" }));
              }
            }}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.confirm ? true : undefined}
            aria-describedby={fieldErrors.confirm ? "confirm-password-error" : undefined}
        />
        {fieldErrors.confirm && (
          <p id="confirm-password-error" className="field-error" role="alert">{fieldErrors.confirm}</p>
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

        <div className="py-4">
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
