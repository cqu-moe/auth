import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@cqu-moe/ui";
import { requestAuthentication } from "../lib/recent-authentication";
export default function AdminAuthentication({ children }: { children: ReactNode }) {
  const [strong, setStrong] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    fetch("/api/v1/auth/security/status").then(async response => response.ok ? response.json() : null)
      .then(result => { if (active) setStrong(result?.strong === true); })
      .catch(() => {}).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  if (loading) return <p className="p-6">正在验证管理权限…</p>;
  if (strong) return <>{children}</>;
  return <main className="mx-auto max-w-md space-y-4 p-6"><h1 className="text-xl font-semibold">验证管理身份</h1><p>管理功能需要 Passkey，或密码与身份验证器、恢复码。尚未设置时，请先完成安全设置。</p><Button onClick={async () => setStrong(await requestAuthentication("admin"))}>验证并进入</Button><Link className="ml-4 underline" to="/settings/two-factor">安全设置</Link></main>;
}
