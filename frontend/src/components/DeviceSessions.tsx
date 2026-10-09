import { useState } from "react";
import { Alert, AlertDescription, Button } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";

type Device = { token: string; userAgent?: string | null; createdAt: Date };
export default function DeviceSessions() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setError(""); setBusy(true);
    try {
      const [result, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
      setCurrentToken(current.data?.session.token ?? null);
      if (result.error) setError(result.error.message ?? "无法读取登录设备");
      else setDevices(result.data ?? []);
    } catch { setError("无法读取登录设备，请稍后重试"); }
    finally { setBusy(false); }
  }
  async function revoke(token?: string) {
    setError(""); setBusy(true);
    try {
      const result = token ? await authClient.revokeSession({ token }) : await authClient.revokeSessions();
      if (result.error) { setError(result.error.message ?? "退出失败，请稍后重试"); return; }
      if (!token || token === currentToken) { window.location.assign("/login"); return; }
      await load();
    } catch { setError("退出失败，请稍后重试"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 pt-4">
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">登录设备</span>
      <Button variant="link" size="sm" disabled={busy} onClick={load}>查看登录设备</Button>
    </div>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {devices && <>
      <p className="text-xs text-muted-foreground">退出设备会同时结束该设备的应用访问，后台课表同步保持运行。</p>
      {devices.map(device => <div key={device.token} className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{device.token === currentToken ? "当前设备：" : ""}{device.userAgent || "未知设备"} · {new Date(device.createdAt).toLocaleDateString("zh-CN")}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => revoke(device.token)}>退出此设备</Button>
      </div>)}
      <Button variant="outline" disabled={busy} onClick={() => revoke()}>退出全部设备（包括当前设备）</Button>
    </>}
  </div>;
}
