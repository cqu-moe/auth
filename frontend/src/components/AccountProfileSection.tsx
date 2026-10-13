import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
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
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const shouldFocusEditButton = useRef(false);
  const shouldFocusNameInput = useRef(false);
  const nameSubmitLockRef = useRef(false);
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const [confirmedName, setConfirmedName] = useState<string | null>(null);
  const [nameError, setNameError] = useState("");
  const [nameSuccess, setNameSuccess] = useState(false);
  const [nameLoading, setNameLoading] = useState(false);

  const currentName = confirmedName ?? name;

  useEffect(() => {
    setDisplayName(name);
    setConfirmedName(null);
  }, [name]);

  useEffect(() => {
    if (!editingName && shouldFocusEditButton.current) {
      shouldFocusEditButton.current = false;
      editButtonRef.current?.focus();
    }
  }, [editingName]);

  useEffect(() => {
    if (editingName && shouldFocusNameInput.current) {
      shouldFocusNameInput.current = false;
      nameInputRef.current?.focus();
    }
  }, [editingName]);

  const openNameEditor = () => {
    setDisplayName(currentName);
    setNameError("");
    setNameSuccess(false);
    shouldFocusNameInput.current = true;
    setEditingName(true);
  };

  const closeNameEditor = () => {
    setDisplayName(currentName);
    setNameError("");
    shouldFocusEditButton.current = true;
    setEditingName(false);
  };

  const handleNameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (
      event.key !== "Escape" ||
      nameLoading ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return;
    }

    event.preventDefault();
    closeNameEditor();
  };

  const handleNameSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (nameLoading || nameSubmitLockRef.current) return;

    setNameError("");
    setNameSuccess(false);

    const validation = validateDisplayName(displayName);
    if (validation.error || validation.value === null) {
      setNameError(validation.error ?? "昵称不合法");
      return;
    }

    setNameLoading(true);
    nameSubmitLockRef.current = true;
    try {
      let updateError: string | null = null;
      try {
        const { error } = await authClient.updateUser({ name: validation.value });
        if (error) updateError = error.message || "昵称修改失败，请稍后重试";
      } catch {
        updateError = "昵称修改失败，请稍后重试";
      }

      if (updateError !== null) {
        setNameError(updateError || "昵称修改失败，请稍后重试");
        return;
      }

      // Keep the server-confirmed value visible even if the local refetch fails.
      setConfirmedName(validation.value);
      setDisplayName(validation.value);
      await onSessionRefresh().catch(() => undefined);
      shouldFocusEditButton.current = true;
      setEditingName(false);
      setNameSuccess(true);
    } finally {
      nameSubmitLockRef.current = false;
      setNameLoading(false);
    }
  };

  return (
    <SettingsCard title="个人信息">
      <div className="divide-y divide-border">
        <div className="pb-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {editingName ? (
              <Label htmlFor="displayName" className="w-16 shrink-0 text-sm text-muted-foreground">
                昵称
              </Label>
            ) : (
              <span className="w-16 shrink-0 text-sm text-muted-foreground">昵称</span>
            )}

            {editingName ? (
              <form
                id="display-name-editor"
                onSubmit={handleNameSubmit}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                noValidate
              >
                <Input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    if (nameError) setNameError("");
                  }}
                  onKeyDown={handleNameKeyDown}
                  readOnly={nameLoading}
                  required
                  maxLength={64}
                  autoComplete="name"
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={
                    nameError ? "display-name-hint display-name-error" : "display-name-hint"
                  }
                  placeholder="请输入昵称"
                  ref={nameInputRef}
                  className="h-9 min-w-0 flex-1 basis-40"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
                <p id="display-name-hint" className="sr-only">
                  最多 64 个字符，保存时会移除首尾空格。
                </p>
                {nameError && (
                  <p id="display-name-error" className="basis-full field-error" role="alert">
                    <AlertCircle aria-hidden="true" />
                    {nameError}
                  </p>
                )}
              </form>
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-end gap-4">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {currentName || "—"}
                </span>
                <Button
                  ref={editButtonRef}
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
            )}
          </div>

          {nameSuccess && !editingName && (
            <p className="mt-2 flex items-center justify-end gap-1 text-xs text-success" role="status">
              <Check aria-hidden="true" size={14} />
              昵称已更新
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-4">
          <span className="w-16 shrink-0 text-sm text-muted-foreground">邮箱</span>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-4">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {email || "—"}
            </span>
            <Button asChild variant="link" size="sm" aria-label="修改邮箱" className="shrink-0">
              <Link to="/settings/email">修改</Link>
            </Button>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
