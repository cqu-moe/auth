import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ActionButton, Alert, AlertDescription, Skeleton } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import { withRedirectParam } from "../lib/post-login-redirect";

type Device = { token: string; userAgent?: string | null; createdAt: Date };

type BusyAction = "load" | "revoke" | "revoke-all";

export default function DeviceSessions() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const autoLoad = searchParams.get("devices") === "1";
  const autoLoaded = useRef(false);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [revokeToken, setRevokeToken] = useState<string | null>(null);
  const load = useCallback(async (allowLoginRedirect = true) => {
    setError(""); setBusy("load");
    try {
      const [result, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
      setCurrentToken(current.data?.session.token ?? null);
      if (result.error?.code === "SESSION_NOT_FRESH") {
        if (allowLoginRedirect) {
          navigate(withRedirectParam("/login?reason=session-not-fresh", "/settings/security?devices=1#login-devices"));
        } else {
          setError("仍需重新登录才能查看登录设备，请点击“重试读取”重试。");
        }
      }
      else if (result.error) setError(result.error.message ?? "无法读取登录设备");
      else setDevices(result.data ?? []);
    } catch { setError("无法读取登录设备，请稍后重试"); }
    finally { setBusy(null); }
  }, [navigate]);
  useEffect(() => {
    if (!autoLoad || autoLoaded.current) return;
    autoLoaded.current = true;
    // A failed return must not bounce indefinitely between settings and login.
    void load(false);
  }, [autoLoad, load]);
  async function revoke(token?: string) {
    setError(""); setBusy(token ? "revoke" : "revoke-all"); setRevokeToken(token ?? null);
    try {
      const result = token ? await authClient.revokeSession({ token }) : await authClient.revokeSessions();
      if (result.error) { setError(result.error.message ?? "退出失败，请稍后重试"); return; }
      if (!token || token === currentToken) { window.location.assign("/login"); return; }
      await load();
    } catch { setError("退出失败，请稍后重试"); }
    finally { setBusy(null); setRevokeToken(null); }
  }
  const firstLoad = devices === null && busy === "load";

  return <div id="login-devices" className="space-y-3 pt-4" aria-busy={busy !== null}>
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">登录设备</span>
      <ActionButton
        variant="link"
        size="sm"
        disabled={busy !== null}
        onClick={() => void load()}
        state={busy === "load" ? "loading" : error && devices === null ? "error" : "idle"}
        labels={{
          idle: "查看登录设备",
          loading: "正在读取…",
          success: "已读取",
          error: "重试读取",
        }}
      />
    </div>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {firstLoad ? <div role="status">
      <span className="sr-only">正在读取登录设备…</span>
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="h-4 w-full max-w-xl" />
        {[0, 1, 2].map((device) => (
          <div key={device} className="flex items-center justify-between gap-3">
            <Skeleton className="h-5 min-w-0 flex-1" />
            <ActionButton variant="outline" size="sm" disabled state="idle" labels={{ idle: "退出此设备", loading: "正在退出…", success: "已退出", error: "重试退出" }} />
          </div>
        ))}
        <ActionButton variant="outline" disabled state="idle" labels={{ idle: "退出全部设备（包括当前设备）", loading: "正在退出全部设备…", success: "已退出", error: "重试退出" }} />
      </div>
    </div> : devices && <>
      <p className="text-xs text-muted-foreground">退出设备会同时结束该设备的应用访问，后台课表同步保持运行。</p>
      {devices.length === 0 && <p className="text-sm text-muted-foreground">当前没有登录设备记录。</p>}
      {devices.map(device => <div key={device.token} className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{device.token === currentToken ? "当前设备：" : ""}{device.userAgent || "未知设备"} · {new Date(device.createdAt).toLocaleDateString("zh-CN")}</span>
        <ActionButton
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void revoke(device.token)}
          state={busy === "revoke" && revokeToken === device.token ? "loading" : "idle"}
          labels={{
            idle: "退出此设备",
            loading: "正在退出…",
            success: "已退出",
            error: "重试退出",
          }}
        />
      </div>)}
      <ActionButton
        variant="outline"
        disabled={busy !== null}
        onClick={() => void revoke()}
        state={busy === "revoke-all" ? "loading" : "idle"}
        labels={{
          idle: "退出全部设备（包括当前设备）",
          loading: "正在退出全部设备…",
          success: "已退出",
          error: "重试退出",
        }}
      />
    </>}
  </div>;
}
