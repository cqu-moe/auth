import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import Layout from "../components/Layout";

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
  const [clientInfo, setClientInfo] = useState<{ name: string; icon?: string | null } | null>(null);

  const clientId = searchParams.get("client_id") ?? "";
  const scopeParam = searchParams.get("scope") ?? "openid";
  const scopes = scopeParam.split(" ").filter(Boolean);

  useEffect(() => {
    if (!clientId) return;
    authClient.oauth2.publicClient({ query: { client_id: clientId } }).then((res) => {
      if (res.data) {
        setClientInfo({ name: (res.data.name as string) ?? clientId, icon: res.data.icon as string | null });
      }
    }).catch(() => {
      setClientInfo({ name: clientId });
    });
  }, [clientId]);

  const clientName = clientInfo?.name ?? clientId ?? "未知应用";

  const handleConsent = async (accept: boolean) => {
    setLoading(true);
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
    setLoading(false);
  };

  return (
    <Layout>
      <div className="max-w-md mx-auto">
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4 overflow-hidden">
            {clientInfo?.icon ? (
              <img src={clientInfo.icon} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            )}
          </div>

          <h2 className="text-xl font-semibold text-gray-900 text-center mb-1">授权请求</h2>
          <p className="text-sm text-gray-500 text-center mb-6">
            <span className="font-medium text-gray-800">{clientName}</span> 请求以下权限
          </p>

          <div className="space-y-2 mb-6">
            {scopes.map((scope) => {
              const info = getScopeInfo(scope);
              const isCquScope = scope.startsWith("cqu:");
              return (
                <div
                  key={scope}
                  className={`flex items-start gap-3 p-3 rounded-xl ${
                    isCquScope ? "bg-orange-50 border border-orange-100" : "bg-gray-50"
                  }`}
                >
                  <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                    isCquScope ? "bg-orange-100" : "bg-blue-100"
                  }`}>
                    <svg className={`w-3 h-3 ${isCquScope ? "text-orange-600" : "text-blue-600"}`} fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{info.label}</p>
                    <p className="text-xs text-gray-500">{info.description}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {scopes.some((s) => s.startsWith("cqu:")) && (
            <div className="mb-6 p-3 bg-yellow-50 border border-yellow-200 rounded-xl text-xs text-yellow-700">
              该应用请求访问您的 CQU 账户。授权后，该应用将可以以您的身份访问相关 CQU 系统。请确认您信任该应用。
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => handleConsent(false)}
              disabled={loading}
              className="flex-1 py-2.5 px-4 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg transition-colors"
            >
              拒绝
            </button>
            <button
              onClick={() => handleConsent(true)}
              disabled={loading}
              className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {loading ? "处理中..." : "授权"}
            </button>
          </div>

          <p className="mt-4 text-xs text-gray-400 text-center">
            授权后，该应用将获得上述权限。您可以随时在设置中撤销授权。
          </p>
        </div>
      </div>
    </Layout>
  );
}
