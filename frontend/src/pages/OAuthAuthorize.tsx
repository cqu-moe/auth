import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { AppWindow, ShieldAlert } from "lucide-react";
import { ActionButton, Alert, AlertDescription, Button, Skeleton } from "@cqu-moe/ui";
import AuthLayout from "../components/AuthLayout";
import OAuthPermissions from "../components/OAuthPermissions";
import { authClient } from "../lib/auth-client";

function clientMeta(value: unknown, clientId: string) {
  const meta = value as Record<string, unknown>;
  const name = [meta.name, meta.client_name]
    .find((item): item is string => typeof item === "string" && item.trim() !== "");
  const icon = [meta.icon, meta.logo_uri]
    .find((item): item is string => typeof item === "string" && item.trim() !== "");
  return { name: name ?? clientId, icon: icon ?? null };
}

export default function OAuthAuthorize() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState<"accept" | "reject" | null>(null);
  const [failedAction, setFailedAction] = useState<"accept" | "reject" | null>(null);
  const [clientInfo, setClientInfo] = useState<{ name: string; icon?: string | null } | null>(null);
  const [clientStatus, setClientStatus] = useState<"loading" | "ready" | "error">("loading");
  const [clientAttempt, setClientAttempt] = useState(0);

  const clientId = searchParams.get("client_id") ?? "";
  const scopeParam = searchParams.get("scope") ?? "openid";
  const scopes = scopeParam.split(" ").filter(Boolean);

  useEffect(() => {
    let current = true;
    setClientInfo(null);
    if (!clientId) {
      setClientStatus("error");
    } else {
      setClientStatus("loading");
      authClient.oauth2.publicClient({ query: { client_id: clientId } }).then((res) => {
        if (!current) return;
        if (res.data) {
          setClientInfo(clientMeta(res.data, clientId));
          setClientStatus("ready");
        } else {
          setClientStatus("error");
        }
      }).catch(() => {
        if (!current) return;
        setClientInfo({ name: clientId });
        setClientStatus("error");
      });
    }
    return () => { current = false; };
  }, [clientId, clientAttempt]);

  const clientName = clientInfo?.name ?? clientId ?? "未知应用";
  const clientLoading = clientStatus === "loading";

  const handleConsent = async (accept: boolean) => {
    setLoading(accept ? "accept" : "reject");
    setFailedAction(null);
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
    setFailedAction(accept ? "accept" : "reject");
    setLoading(null);
  };

  return (
    <AuthLayout
      title="授权请求"
      description={
        clientLoading ? (
          <div className="inline-flex flex-wrap items-center gap-2">
            <span className="sr-only" role="status">正在读取应用名称…</span>
            <Skeleton className="h-4 w-32 max-w-full" aria-hidden="true" />
            <span>请求访问您的账户。</span>
          </div>
        ) : (
          `${clientName} 请求访问您的账户。`
        )
      }
    >
      {clientLoading ? (
        <div className="mx-auto mb-4 flex w-full max-w-16" aria-hidden="true">
          <Skeleton className="size-16 rounded-lg" />
        </div>
      ) : clientInfo?.icon ? (
        <img src={clientInfo.icon} alt="" className="mx-auto mb-4 size-16 rounded-lg object-cover" />
      ) : <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true"><AppWindow size={32} /></div>}

      {clientStatus === "error" && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            <span>{clientId ? "无法读取应用信息，当前显示客户端 ID。" : "缺少客户端 ID，无法读取应用信息。"}</span>
            {clientId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setClientAttempt((attempt) => attempt + 1)}
              >
                重新读取应用信息
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <OAuthPermissions scopes={scopes} />

      {failedAction && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>授权处理失败，请重试。</AlertDescription>
        </Alert>
      )}

      <div className="mt-6 flex gap-3">
        <ActionButton
          variant="outline"
          className="flex-1"
          onClick={() => void handleConsent(false)}
          disabled={loading !== null || clientLoading}
          state={loading === "reject" ? "loading" : failedAction === "reject" ? "error" : "idle"}
          labels={{
            idle: "拒绝",
            loading: "正在拒绝…",
            success: "已拒绝",
            error: "重试拒绝",
          }}
        />
        <ActionButton
          type="button"
          className="flex-1"
          disabled={loading !== null || clientLoading}
          state={loading === "accept" ? "loading" : failedAction === "accept" ? "error" : "idle"}
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
