import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import {
  validateDisplayName,
} from "../lib/account-settings";

interface AccountProfileSectionProps {
  name: string;
  email: string;
  onSessionRefresh: () => Promise<unknown>;
}

function EditIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487zM19.5 7.125L16.862 4.487M18 14.25V19.5A1.5 1.5 0 0116.5 21h-12A1.5 1.5 0 013 19.5v-12A1.5 1.5 0 014.5 6H9.75"
      />
    </svg>
  );
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
    <div className="rounded-2xl border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-base font-semibold text-gray-900">个人信息</h3>

      <div className="space-y-3">
        <div className="border-b border-gray-100 py-2">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-gray-500">昵称</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-gray-900">{name || "—"}</span>
              <button
                type="button"
                onClick={openNameEditor}
                aria-label="修改昵称"
                aria-expanded={editingName}
                aria-controls="display-name-editor"
                className="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
              >
                <EditIcon />
              </button>
            </div>
          </div>

          {editingName && (
            <form
              id="display-name-editor"
              onSubmit={handleNameSubmit}
              className="mt-3 rounded-xl bg-gray-50 p-3"
            >
              <label htmlFor="displayName" className="mb-1.5 block text-xs font-medium text-gray-600">
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
                  className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              <p className="mt-1.5 text-xs text-gray-400">最多 64 个字符，保存时会移除首尾空格。</p>
              {nameError && <p className="mt-2 text-sm text-red-700" role="alert">{nameError}</p>}
            </form>
          )}

          {nameSuccess && !editingName && (
            <p className="mt-2 text-right text-xs text-green-700" role="status">昵称已更新</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 py-2">
          <span className="text-sm text-gray-500">邮箱</span>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-gray-900">{email || "—"}</span>
            <Link
              to="/settings/email"
              aria-label="修改邮箱"
              className="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
            >
              <EditIcon />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
