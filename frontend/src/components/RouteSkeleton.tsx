import { useLocation } from "react-router-dom";
import { ActionButton, Button, PageHeader, Skeleton } from "@cqu-moe/ui";
import { ShieldAlert } from "lucide-react";
import OAuthPermissions from "./OAuthPermissions";
import Layout from "./Layout";
import AuthLayout from "./AuthLayout";
import SettingsCard from "./SettingsCard";
import AdminLayout, { AdminPage } from "../pages/Admin";
import { UsersSkeleton, EntitlementsSkeleton, InvitationsSkeleton, OAuthClientsSkeleton } from "../features/admin/AdminSkeletons";
import { AccountSkeleton, CquBindingSkeleton, PasskeySkeleton, QuickloginSkeleton } from "./SettingsSkeletons";
import { BindingSkeleton } from "./BindingSkeleton";
import { authClient } from "../lib/auth-client";

export function UsersRouteSkeleton() {
  const { data: session } = authClient.useSession();
  return <UsersSkeleton canEditQuota={(session?.user as { role?: string } | undefined)?.role === "superAdmin"} />;
}

export function AdminContentSkeleton() {
  const { pathname } = useLocation();
  if (pathname.endsWith("/presets")) return <AdminPage title="权益预设" description="维护能力预设与新用户默认权益。"><EntitlementsSkeleton /></AdminPage>;
  if (pathname.endsWith("/invitations")) return <AdminPage title="注册邀请" description="生成与管理注册邀请码。"><InvitationsSkeleton /></AdminPage>;
  if (pathname.endsWith("/oauth")) return <AdminPage title="OAuth 客户端" description="管理第三方应用的 OAuth 接入。"><OAuthClientsSkeleton /></AdminPage>;
  return <AdminPage title="用户管理" description="查看用户、调整角色与封禁状态。"><UsersRouteSkeleton /></AdminPage>;
}

/** Only public layout and placeholders: never mounts a protected page or its requests. */
export default function RouteSkeleton() {
  const { pathname, search } = useLocation();
  if (pathname.startsWith("/admin")) return <AdminLayout><AdminContentSkeleton /></AdminLayout>;
  if (pathname === "/settings/cqu") return <Layout>
    <PageHeader title="CQU 集成" description="绑定学校账号、维护统一认证会话与快捷登录。" />
    <div className="space-y-8">
      <SettingsCard title="CQU 账户绑定" description="绑定后由系统代你维护与重庆大学统一认证的会话。"><CquBindingSkeleton /></SettingsCard>
      <SettingsCard title="浏览器快捷登录" description="每个安装实例使用独立学校会话" action={<Skeleton className="h-5 w-9" />}><QuickloginSkeleton /></SettingsCard>
    </div>
  </Layout>;
  if (pathname === "/settings/security") return <Layout>
    <PageHeader title="安全" description="二次验证与登录密码。" />
    <div className="space-y-8">
      <SettingsCard title="安全设置"><div className="divide-y divide-border" aria-hidden="true">
        <div className="flex items-center justify-between gap-4 pb-4"><span className="w-16 shrink-0 text-sm text-muted-foreground">二次验证</span><div className="min-w-0 flex-1"><Skeleton className="h-7 w-20" /></div><Button variant="link" size="sm" disabled>设置</Button></div>
        <div className="flex items-center justify-between gap-4 py-4"><span className="w-16 shrink-0 text-sm text-muted-foreground">密码</span><span className="min-w-0 flex-1 text-sm text-muted-foreground">定期更换密码可提升账户安全性。</span><Button variant="link" size="sm" disabled>修改</Button></div>
        <div className="flex items-center justify-between gap-4 pt-4"><span className="text-sm text-muted-foreground">登录设备</span><Button variant="link" size="sm" disabled>查看登录设备</Button></div>
      </div></SettingsCard>
      <SettingsCard title="Passkey" description="使用指纹、面容或设备 PIN 登录和验证身份。可添加多个 Passkey，密码登录仍可使用。">
        <div className="space-y-4"><PasskeySkeleton /><div className="border-t border-border pt-4"><Skeleton className="h-11 w-36" /></div></div>
      </SettingsCard>
    </div>
  </Layout>;
  if (pathname === "/cqu/bind") {
    const repair = new URLSearchParams(search).get("repair") === "1";
    return <Layout><Skeleton className="mb-4 h-8 w-24" aria-hidden="true" />
      <PageHeader title={repair ? "重新设置 CQU 密码" : "绑定 CQU 账号"} description={repair ? "验证新密码并恢复统一认证会话。" : "按步骤完成统一认证账号绑定。"} />
      <div className="content-panel"><BindingSkeleton repair={repair} /></div>
    </Layout>;
  }
  if (pathname === "/settings/email") return <Layout>
    <Skeleton className="mb-5 h-8 w-28" aria-hidden="true" />
    <PageHeader title="修改登录邮箱" description="当前邮箱：" />
    <div className="mb-6 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:gap-4" aria-hidden="true">
      {[0, 1, 2].map(step => <Skeleton key={step} className="h-5 w-32" />)}
    </div>
    <section className="content-panel" aria-hidden="true"><p className="text-base font-semibold">验证当前邮箱</p><p className="mt-1 text-sm text-muted-foreground">先向当前登录邮箱发送 6 位验证码。</p><Skeleton className="mt-4 h-10 w-32" /></section>
  </Layout>;
  if (pathname === "/settings/two-factor") {
    return <Layout><Skeleton className="mb-4 h-8 w-28" aria-hidden="true" />
      <PageHeader title="设置二次验证" description="使用身份验证器生成验证码，为账户增加一层保护。" />
      <div className="content-panel space-y-4" aria-hidden="true"><Skeleton className="h-11 w-full" /><Skeleton className="h-5 w-24" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-28" /></div>
    </Layout>;
  }
  if (pathname === "/settings" || pathname === "/") return <Layout><PageHeader title="账户" description="登录账户和对外展示的基本信息。" /><AccountSkeleton /></Layout>;
  if (pathname === "/verify-email") return <AuthLayout title="输入邮箱验证码" description="最后一步：验证你的邮箱地址。">
    <div aria-hidden="true">
      <div className="mb-5 flex items-center gap-3"><Skeleton className="size-10 shrink-0" /><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-6 w-48 max-w-full" /></div></div>
      <div className="space-y-4"><div className="field"><p className="text-sm font-medium">六位验证码</p><Skeleton className="h-11 w-full" /><p className="field-hint">仅输入邮件中的数字</p></div><Skeleton className="h-10 w-full" /></div>
      <Skeleton className="mx-auto mt-5 h-11 w-48 max-w-full" /><Skeleton className="mx-auto mt-4 h-9 w-24" />
    </div>
  </AuthLayout>;
  if (pathname === "/oauth/authorize") {
    const scopes = (new URLSearchParams(search).get("scope") ?? "openid").split(" ").filter(Boolean);
    return <AuthLayout title="授权请求" description={<div className="inline-flex flex-wrap items-center gap-2"><Skeleton className="h-4 w-32 max-w-full" aria-hidden="true" /><span>请求访问您的账户。</span></div>}>
      <div className="mx-auto mb-4 flex w-full max-w-16" aria-hidden="true"><Skeleton className="size-16 rounded-lg" /></div>
      <OAuthPermissions scopes={scopes} />
      <div className="mt-6 flex gap-3" aria-hidden="true">
        <ActionButton variant="outline" className="flex-1" disabled state="idle" labels={{ idle: "拒绝", loading: "正在拒绝…", success: "已拒绝", error: "重试拒绝" }} />
        <ActionButton className="flex-1" disabled state="idle" labels={{ idle: "授权", loading: "处理中…", success: "已授权", error: "重试授权" }} />
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground"><ShieldAlert aria-hidden="true" size={12} className="mr-1 inline align-[-2px]" />授权后，该应用将获得上述权限。您可以随时在设置中撤销授权。</p>
    </AuthLayout>;
  }
  return <AuthLayout title="找不到这个页面" description="链接可能已失效，或地址输入有误。"><Skeleton className="mx-auto h-10 w-28" aria-hidden="true" /></AuthLayout>;
}
