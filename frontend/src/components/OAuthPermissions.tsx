import { Check } from "lucide-react";
import { Alert, AlertDescription } from "@cqu-moe/ui";

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
  "cqu:ticket:friends": { label: "第二课堂", description: "代表您访问重庆大学第二课堂系统" },
};

function getScopeInfo(scope: string): ScopeInfo {
  return SCOPE_MAP[scope] ?? { label: scope, description: `授予 ${scope} 权限` };
}

/** Requested scopes are known before client metadata or the session arrives. */
export default function OAuthPermissions({ scopes }: { scopes: string[] }) {
  return <>
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

  </>;
}
