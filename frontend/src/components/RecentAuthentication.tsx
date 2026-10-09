import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Label } from "@cqu-moe/ui";
import type { AuthenticationRequest } from "../lib/recent-authentication";

export default function RecentAuthentication() {
  const [pending, setPending] = useState<AuthenticationRequest | null>(null);
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState("totp");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<AuthenticationRequest>).detail;
      setPending((previous) => { previous?.resolve(false); return request; });
      setPassword(""); setChallenge(""); setCode(""); setError("");
    };
    window.addEventListener("auth:verify", listener);
    return () => window.removeEventListener("auth:verify", listener);
  }, []);
  if (!pending) return null;
  const finish = (verified: boolean) => { pending.resolve(verified); setPending(null); setPassword(""); setCode(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/auth/security/${challenge ? "complete" : "challenge"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(challenge ? { challenge, method, code } : { password, purpose: pending.purpose }),
      });
      const result = await response.json();
      setPassword("");
      if (!response.ok) { setChallenge(""); setCode(""); setError(result.message ?? "验证失败，请重新输入密码"); return; }
      if (result.verified) finish(true);
      else setChallenge(result.challenge);
    } catch { setError("网络错误，请重试"); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="recent-auth-title" className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg">
      <h2 id="recent-auth-title" className="text-lg font-semibold">验证身份后继续</h2>
      <p className="my-3 text-sm text-muted-foreground">请确认是你本人操作，验证在五分钟内有效。</p>
      <form onSubmit={submit} className="space-y-4">
        {challenge ? <><Label htmlFor="recent-factor">验证方式</Label><select id="recent-factor" value={method} onChange={e => setMethod(e.target.value)}><option value="totp">身份验证器</option><option value="backup-code">备用恢复码</option></select><Label htmlFor="recent-code">验证码</Label><Input id="recent-code" autoFocus autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required /></> : <><Label htmlFor="recent-password">当前密码</Label><Input id="recent-password" type="password" autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></>}
        {error && <p role="alert" className="text-sm text-destructive">{error}{error.includes("设置") && <a href="/settings/two-factor" className="underline"> 前往安全设置</a>}</p>}
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => finish(false)}>取消</Button><Button type="submit" disabled={busy}>{busy ? "正在验证…" : "验证并继续"}</Button></div>
      </form>
    </section>
  </div>;
}
