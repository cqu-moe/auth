import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ActionButton, Alert, AlertDescription, Button, Dialog, DialogContent,
  DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, toast,
} from "@cqu-moe/ui";
import { KeyRound, Plus } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { requestAuthentication } from "../lib/recent-authentication";
import { PasskeySkeleton } from "./SettingsSkeletons";
import SettingsCard from "./SettingsCard";

type Key = { id: string; name?: string | null };
type Editor = { kind: "add" } | { kind: "rename" | "delete"; key: Key };

export default function PasskeySettings() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const busyRef = useRef(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const { data, error } = await authClient.passkey.listUserPasskeys();
      if (error) setLoadError("无法读取 Passkey，请重新加载。");
      else setKeys(data ?? []);
    } catch { setLoadError("无法读取 Passkey，请检查网络后重新加载。"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openEditor = (next: Editor, trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    setName(next.kind === "rename" ? next.key.name ?? "" : "");
    setError("");
    setNameError("");
    setEditor(next);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || busyRef.current) return;
    const trimmedName = name.trim();
    if (editor.kind !== "delete" && !trimmedName) {
      setNameError("请输入一个方便辨认的名称。");
      nameInput.current?.focus();
      return;
    }
    if (editor.kind === "rename" && trimmedName === editor.key.name) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (!await requestAuthentication("mfa")) return;
      const result = editor.kind === "add"
        ? await authClient.passkey.addPasskey({ name: trimmedName })
        : editor.kind === "rename"
          ? await authClient.passkey.updatePasskey({ id: editor.key.id, name: trimmedName })
          : await authClient.passkey.deletePasskey({ id: editor.key.id });
      if (result.error) {
        setError("操作未完成，请确认设备验证后重试。");
        return;
      }
      // Once the write succeeds, a failed refresh must not invite a duplicate write.
      await load();
      setEditor(null);
      toast.success(editor.kind === "add" ? "Passkey 已添加" : editor.kind === "rename" ? "名称已更新" : "Passkey 已删除");
    } catch { setError("Passkey 操作未完成，请重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const deleting = editor?.kind === "delete";
  const title = deleting ? "删除 Passkey" : editor?.kind === "rename" ? "重命名 Passkey" : "添加 Passkey";

  return <>
    <SettingsCard title="Passkey" description="使用指纹、面容或设备 PIN 登录和验证身份。可添加多个 Passkey，密码登录仍可使用。">
      <div className="space-y-4" aria-busy={loading}>
        {loadError && <Alert variant="destructive">
          <AlertDescription>
            <p>{loadError}</p>
            <Button type="button" variant="outline" size="sm" className="mt-3 min-h-11" onClick={() => void load()}>重新加载</Button>
          </AlertDescription>
        </Alert>}
        {loading && keys.length === 0 && <PasskeySkeleton />}
        {!loading && !loadError && keys.length === 0 && <p className="text-sm text-muted-foreground">尚未添加 Passkey。添加后即可使用设备解锁登录。</p>}
        {keys.length > 0 && <ul aria-label="已添加的 Passkey" className="divide-y divide-border">
          {keys.map(key => <li key={key.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <KeyRound className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 break-all text-sm font-medium">{key.name || "未命名 Passkey"}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <Button type="button" variant="ghost" size="sm" className="min-h-11" disabled={busy || loading} aria-label={`重命名 ${key.name || "未命名 Passkey"}`} onClick={event => openEditor({ kind: "rename", key }, event.currentTarget)}>重命名</Button>
              <Button type="button" variant="destructive" size="sm" className="min-h-11" disabled={busy || loading} aria-label={`删除 ${key.name || "未命名 Passkey"}`} onClick={event => openEditor({ kind: "delete", key }, event.currentTarget)}>删除</Button>
            </div>
          </li>)}
        </ul>}
        <div className={keys.length || loading ? "border-t border-border pt-4" : undefined}>
          <Button ref={addButton} type="button" variant="outline" className="min-h-11" disabled={busy || loading} onClick={event => openEditor({ kind: "add" }, event.currentTarget)}>
            <Plus aria-hidden="true" />添加 Passkey
          </Button>
        </div>
      </div>
    </SettingsCard>
    <Dialog open={editor !== null} onOpenChange={open => { if (!open && !busyRef.current) setEditor(null); }}>
      <DialogContent className="max-w-sm" showCloseButton={!busy}
        onOpenAutoFocus={event => {
          if (window.matchMedia?.("(pointer: coarse)").matches) {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const target = returnFocus.current;
          (target?.isConnected && !target.disabled ? target : addButton.current)?.focus();
        }}
        onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault(); }}
        onPointerDownOutside={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {deleting ? "删除后，将无法使用此 Passkey 登录。其他登录方式不受影响。"
              : editor?.kind === "rename" ? "修改显示名称，方便区分不同设备。"
                : "为这个 Passkey 起个名称，再按照设备提示完成验证。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void save(event)} className="space-y-4" noValidate>
          {deleting ? <p className="break-all text-sm font-medium">{editor.key.name || "未命名 Passkey"}</p> : <div className="space-y-2">
            <Label htmlFor="passkey-name">名称</Label>
            <Input ref={nameInput} id="passkey-name" value={name} onChange={event => {
              setName(event.target.value);
              if (nameError && event.target.value.trim()) setNameError("");
              setError("");
            }} placeholder="例如：我的手机" maxLength={100} disabled={busy} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
              required aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "passkey-name-error" : undefined} />
            {nameError && <p id="passkey-name-error" role="alert" className="text-sm text-destructive">{nameError}</p>}
          </div>}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => setEditor(null)}>取消</Button>
            <ActionButton type="submit" className="min-h-11" variant={deleting ? "destructive" : "default"}
              state={busy ? "loading" : error ? "error" : "idle"}
              disabled={editor?.kind === "rename" && name.trim() === editor.key.name}
              labels={{ idle: deleting ? "确认删除" : editor?.kind === "rename" ? "保存名称" : "添加并保存", loading: "正在验证…", success: "已完成", error: "重试" }} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
