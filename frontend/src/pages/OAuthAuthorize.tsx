import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, ShieldAlert } from "lucide-react";
import { ActionButton, Alert, AlertDescription, Button } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import { authClient } from "../lib/auth-client";

interface ScopeInfo {
  label: string;
  description: string;
}

const SCOPE_MAP: Record<string, ScopeInfo> = {
  openid: { label: "身份验证", description: "确认您的身份" },
  profile: { label: "个人资料", description: "访问您的用户名等基本信息" },
  email: { label: "邮箱地址", description: "访问您的邮箱地址" },
  offline_access: { label: "离线访问", description: "在您不在线时保持访问权限（刷新令牌）" },
  roles: { label: "角色信息", description: "访问您的账户角色" },
  "cqu:ticket:jwxt": { label: "教务系统", description: "代表您访问重庆大学教务系统" },
  "cqu:ticket:jxpj": { label: "教学评价", description: "代表您访问重庆大学教学评价系统" },
  "cqu:ticket:library": { label: "图书馆", description: "代表您访问重庆大学图书馆系统" },
  "cqu:ticket:card": { label: "校园卡", description: "代表您访问重庆大学校园卡系统" },
};

function getScopeInfo(scope: string): ScopeInfo {
  return SCOPE_MAP[scope] ?? { label: scope, description: `授予 ${scope} 权限` };
}

export default function OAuthAuthorize() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [clientInfo, setClientInfo] = useState<{ name: string; icon?: string | null } | null>(null);

  const clientId = searchParams.get("client_id") ?? "";
  const scopeParam = searchParams.get("scope") ?? "openid";
  const scopes = scopeParam.split(" ").filter(Boolean);

  useEffect(() => {
    if (!clientId) return;
    authClient.oauth2.publicClient({ query: { client_id: clientId } }).then((res) => {
      if (res.data) {
        const meta = res.data as { name?: unknown; icon?: unknown };
        setClientInfo({
          name: typeof meta.name === "string" ? meta.name : clientId,
          icon: typeof meta.icon === "string" ? meta.icon : null,
        });
      }
    }).catch(() => {
      setClientInfo({ name: clientId });
    });
  }, [clientId]);

  const clientName = clientInfo?.name ?? clientId ?? "未知应用";

  const handleConsent = async (accept: boolean) => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await authClient.oauth2.consent({
        accept,
        scope: accept ? scopeParam : undefined,
      });
      if (res.data?.redirect && res.data?.url) {
        window.location.href = res.data.url;
        return;
      }
    } catch {
      // fall through
    }
    setFailed(true);
    setLoading(false);
  };

  return (
    <AuthLayout title="授权请求" description={`${clientName} 请求访问您的账户。`}>
      {clientInfo?.icon ? (
        <img
          src={clientInfo.icon}
          alt=""
          className="mx-auto mb-4 h-16 w-16 rounded-lg object-cover"
        />
      ) : null}

      <div className="space-y-2">
        {scopes.map((scope) => {
          const info = getScopeInfo(scope);
          const isCquScope = scope.startsWith("cqu:");
          return (
            <div
              key={scope}
              className={`flex items-start gap-3 rounded-lg p-3 ${
                isCquScope ? "border border-warning/40 bg-warning/10" : "bg-muted"
              }`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                  isCquScope ? "bg-warning/20 text-warning" : "bg-link/10 text-link"
                }`}
              >
                <Check aria-hidden="true" size={12} />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">{info.label}</p>
                <p className="text-xs text-muted-foreground">{info.description}</p>
              </div>
            </div>
          );
        })}
      </div>

      {scopes.some((s) => s.startsWith("cqu:")) && (
        <Alert className="mt-4 border-warning/40 bg-warning/10 text-warning">
          <AlertDescription className="text-warning">
            该应用请求访问您的 CQU 账户。授权后，该应用将可以以您的身份访问相关 CQU 系统。请确认您信任该应用。
          </AlertDescription>
        </Alert>
      )}

      {failed && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>授权处理失败，请重试。</AlertDescription>
        </Alert>
      )}

      <div className="mt-6 flex gap-3">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => handleConsent(false)}
          disabled={loading}
        >
          拒绝
        </Button>
        <ActionButton
          type="button"
          className="flex-1"
          state={loading ? "loading" : failed ? "error" : "idle"}
          onClick={() => handleConsent(true)}
          labels={{
            idle: "授权",
            loading: "处理中…",
            success: "已授权",
            error: "重试授权",
          }}
        />
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        <ShieldAlert aria-hidden="true" size={12} className="mr-1 inline align-[-2px]" />
        授权后，该应用将获得上述权限。您可以随时在设置中撤销授权。
      </p>
    </AuthLayout>
  );
}
