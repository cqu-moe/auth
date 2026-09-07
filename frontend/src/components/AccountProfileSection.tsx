import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
      <div className="divide-y divide-gray-100">
        <div className="pb-4">
          <div className="flex items-center justify-between gap-4">
            <span className="w-16 shrink-0 text-sm text-gray-500">昵称</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{name || "—"}</span>
            <button
              type="button"
              onClick={openNameEditor}
              aria-label="修改昵称"
              aria-expanded={editingName}
              aria-controls="display-name-editor"
              className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
            >
              修改
            </button>
          </div>

          {editingName && (
            <form
              id="display-name-editor"
              onSubmit={handleNameSubmit}
              className="mt-3 rounded-xl bg-gray-50 p-4"
            >
              <label htmlFor="displayName" className="mb-1.5 block text-sm font-medium text-gray-700">
                新昵称
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
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
                  className={`min-w-0 flex-1 rounded-lg border bg-white px-3 py-2 text-base focus:outline-none focus:ring-2 sm:text-sm ${
                    nameError
                      ? "border-red-300 focus:ring-red-500"
                      : "border-gray-300 focus:ring-blue-500"
                  }`}
                  placeholder="请输入昵称"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeNameEditor}
                    disabled={nameLoading}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={nameLoading}
                    className="inline-flex min-w-20 items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400"
                  >
                    {nameLoading && (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    )}
                    {nameLoading ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
              <p id="display-name-hint" className="mt-1.5 text-xs text-gray-400">最多 64 个字符，保存时会移除首尾空格。</p>
              {nameError && <p className="mt-2 flex items-center gap-1.5 text-sm text-red-700" role="alert"><span aria-hidden="true">⚠</span>{nameError}</p>}
            </form>
          )}

          {nameSuccess && !editingName && (
            <p className="mt-2 flex items-center justify-end gap-1 text-xs text-green-700" role="status">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              昵称已更新
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 pt-4">
          <span className="w-16 shrink-0 text-sm text-gray-500">邮箱</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{email || "—"}</span>
          <Link
            to="/settings/email"
            aria-label="修改邮箱"
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          >
            修改
          </Link>
        </div>
      </div>
    </SettingsCard>
  );
}
