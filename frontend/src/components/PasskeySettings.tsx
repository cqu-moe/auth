import { useEffect, useState } from "react";
import { Button, Input, Label } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import { requestAuthentication } from "../lib/recent-authentication";
import SettingsCard from "./SettingsCard";

type Key = { id: string; name?: string | null };
export default function PasskeySettings() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      const { data, error } = await authClient.passkey.listUserPasskeys();
      if (error) setError("无法读取 Passkey，请稍后重试");
      else setKeys(data ?? []);
    } catch { setError("无法读取 Passkey，请稍后重试"); }
  };
  useEffect(() => { void load(); }, []);
  const run = async (action: () => Promise<{ error: unknown }>) => {
    setBusy(true); setError("");
    try {
      if (!await requestAuthentication("mfa")) return;
      const result = await action();
      if (result.error) { setError("操作未完成，请确认设备验证后重试"); return; }
      setName(""); await load();
    } catch { setError("Passkey 操作未完成，请重试"); }
    finally { setBusy(false); }
  };
  return <SettingsCard title="Passkey" description="使用指纹、面容或设备 PIN 登录和验证身份。可绑定多个设备，密码登录仍可使用。">
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {keys.length === 0 && <p className="text-sm text-muted-foreground">尚未绑定 Passkey</p>}
      {keys.map(key => <div key={key.id} className="flex flex-wrap items-center gap-2">
        <Input aria-label={`Passkey 名称 ${key.name || "未命名"}`} value={key.name ?? ""} disabled={busy} onChange={event => setKeys(current => current.map(item => item.id === key.id ? { ...item, name: event.target.value } : item))} className="min-w-0 flex-1" />
        <Button variant="outline" disabled={busy || !key.name?.trim()} onClick={() => void run(() => authClient.passkey.updatePasskey({ id: key.id, name: key.name!.trim() }))}>保存名称</Button>
        <Button variant="outline" disabled={busy} onClick={() => void run(() => authClient.passkey.deletePasskey({ id: key.id }))}>删除</Button>
      </div>)}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); void run(() => authClient.passkey.addPasskey({ name: name.trim() || "我的 Passkey" })); }}>
        <Label htmlFor="new-passkey-name">新 Passkey 名称</Label>
        <Input id="new-passkey-name" value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的手机" maxLength={100} disabled={busy} />
        <Button type="submit" disabled={busy}>{busy ? "正在验证…" : "添加 Passkey"}</Button>
      </form>
    </div>
  </SettingsCard>;
}
