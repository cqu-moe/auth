import { ReactNode } from "react";
import { Link, NavLink as RouterNavLink, Outlet, useNavigate } from "react-router-dom";
import { KeyRound, Layers, Settings, Ticket, Users } from "lucide-react";
import { AppShell, ContentContainer, PageHeader } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import ShellUtilities from "../components/ShellUtilities";
import BrandLogo from "../components/BrandLogo";

/** 管理区外壳：独立侧栏列出管理分区，底部提供返回账户设置的入口。 */
export default function AdminLayout({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate("/login");
  };

  return (
    <AppShell
      brand={<Link to="/settings" className="auth-brand"><BrandLogo />CQU Auth</Link>}
      navigation={
        <>
          <span className="ds-nav-label">管理</span>
          <RouterNavLink to="/admin/users">
            <Users aria-hidden="true" />
            用户管理
          </RouterNavLink>
          <RouterNavLink to="/admin/presets">
            <Layers aria-hidden="true" />
            权益预设
          </RouterNavLink>
          <RouterNavLink to="/admin/invitations">
            <Ticket aria-hidden="true" />
            注册邀请
          </RouterNavLink>
          <RouterNavLink to="/admin/oauth">
            <KeyRound aria-hidden="true" />
            OAuth 客户端
          </RouterNavLink>
          <span className="ds-nav-label">返回</span>
          <RouterNavLink to="/settings">
            <Settings aria-hidden="true" />
            账户设置
          </RouterNavLink>
        </>
      }
      utilities={<ShellUtilities onSignOut={handleSignOut} />}
    >
      <ContentContainer width="compact">
        {children ?? <Outlet />}
      </ContentContainer>
    </AppShell>
  );
}

/** 管理分区页面：页头 + 内容卡片。 */
export function AdminPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="content-panel">{children}</div>
    </>
  );
}
