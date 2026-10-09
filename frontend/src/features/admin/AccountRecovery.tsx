import { useState } from "react";
import { Button, Input, Label } from "@cqu-moe/ui";
import { requestAuthentication } from "../../lib/recent-authentication";
import { Modal } from "./ui";

export function AccountRecovery({ user, onClose }: { user: { id: string; name: string; email: string }; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const reset = async () => {
    setBusy(true); setError("");
    try {
      if (!await requestAuthentication("admin")) return;
      const response = await fetch("/api/v1/auth/admin/reset-authentication", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: user.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "重置未完成，请重试");
      setPassword(result.password);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "重置未完成，请重试"); }
    finally { setBusy(false); }
  };
  const close = () => { if (busy) return; setPassword(""); onClose(); };
  return <Modal title="重置全部认证" description={`${user.name} · ${user.email}`} onClose={close} footer={<>
    <Button variant="outline" onClick={close} disabled={busy}>{password ? "已保存，关闭" : "取消"}</Button>
    {!password && <Button variant="destructive" onClick={reset} disabled={busy}>{busy ? "正在重置…" : "确认重置"}</Button>}
  </>}>
    {password ? <div className="space-y-3">
      <p className="text-sm">旧认证已作废。请将新密码交付给用户；关闭后无法再次查看。</p>
      <Label htmlFor="recovery-password">新密码</Label>
      <Input id="recovery-password" value={password} readOnly autoComplete="off" />
      <Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(password); setCopied(true); } catch { setError("复制失败，请手动保存新密码"); } }}>{copied ? "已复制" : "复制密码"}</Button>
    </div> : <p className="text-sm">将作废该用户的旧密码、所有 Passkey、身份验证器、恢复码、信任设备、登录会话和设备访问凭据，生成随机新密码。学校绑定、业务权益和后台同步保留。</p>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </Modal>;
}
