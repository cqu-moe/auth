import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check } from "lucide-react";
import { ActionButton, Button, Input, Label } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import {
  validateDisplayName,
} from "../lib/account-settings";
import SettingsCard from "./SettingsCard";

interface AccountProfileSectionProps {
  name: string;
  email: string;
  onSessionRefresh: () => Promise<unknown>;
}

export default function AccountProfileSection({
  name,
  email,
  onSessionRefresh,
}: AccountProfileSectionProps) {
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const [nameError, setNameError] = useState("");
  const [nameSuccess, setNameSuccess] = useState(false);
  const [nameLoading, setNameLoading] = useState(false);

  useEffect(() => setDisplayName(name), [name]);

  const openNameEditor = () => {
    setDisplayName(name);
    setNameError("");
    setNameSuccess(false);
    setEditingName(true);
  };

  const closeNameEditor = () => {
    setDisplayName(name);
    setNameError("");
    setEditingName(false);
  };

  const handleNameSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setNameError("");
    setNameSuccess(false);

    const validation = validateDisplayName(displayName);
    if (validation.error || validation.value === null) {
      setNameError(validation.error ?? "昵称不合法");
      return;
    }

    setNameLoading(true);
    const { error } = await authClient.updateUser({ name: validation.value });
    if (error) {
      setNameError(error.message ?? "昵称修改失败，请稍后重试");
      setNameLoading(false);
      return;
    }

    setDisplayName(validation.value);
    await onSessionRefresh();
    setNameLoading(false);
    setEditingName(false);
    setNameSuccess(true);
  };

  return (
    <SettingsCard title="个人信息" description="登录账户和对外展示的基本信息。">
      <div className="divide-y divide-border">
        <div className="pb-4">
          <div className="flex items-center justify-between gap-4">
            <span className="w-16 shrink-0 text-sm text-muted-foreground">昵称</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name || "—"}</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={openNameEditor}
              aria-label="修改昵称"
              aria-expanded={editingName}
              aria-controls="display-name-editor"
              className="shrink-0"
            >
              修改
            </Button>
          </div>

          {editingName && (
            <form
              id="display-name-editor"
              onSubmit={handleNameSubmit}
              className="mt-3 rounded-lg bg-muted p-4"
              noValidate
            >
              <div className="field">
                <Label htmlFor="displayName">新昵称</Label>
                <Input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                  maxLength={64}
                  autoComplete="name"
                  autoFocus
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby="display-name-hint"
                  placeholder="请输入昵称"
                />
              </div>
              <p id="display-name-hint" className="field-hint mt-1.5">最多 64 个字符，保存时会移除首尾空格。</p>
              {nameError && (
                <p className="field-error mt-2" role="alert">
                  <AlertCircle aria-hidden="true" />
                  {nameError}
                </p>
              )}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeNameEditor}
                  disabled={nameLoading}
                >
                  取消
                </Button>
                <ActionButton
                  type="submit"
                  disabled={nameLoading}
                  state={nameLoading ? "loading" : nameError ? "error" : "idle"}
                  labels={{
                    idle: "保存",
                    loading: "保存中…",
                    success: "已保存",
                    error: "重试保存",
                  }}
                />
              </div>
            </form>
          )}

          {nameSuccess && !editingName && (
            <p className="mt-2 flex items-center justify-end gap-1 text-xs text-success" role="status">
              <Check aria-hidden="true" size={14} />
              昵称已更新
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 pt-4">
          <span className="w-16 shrink-0 text-sm text-muted-foreground">邮箱</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{email || "—"}</span>
          <Button asChild variant="link" size="sm" aria-label="修改邮箱" className="shrink-0">
            <Link to="/settings/email">修改</Link>
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
