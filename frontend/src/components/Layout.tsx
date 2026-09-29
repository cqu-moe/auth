import { ReactNode } from "react";
import { Link, NavLink as RouterNavLink, useNavigate } from "react-router-dom";
import { KeyRound, LayoutDashboard, Mail, UserRound } from "lucide-react";
import { AppShell, ContentContainer } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import { canAccessAdmin } from "../../../shared/user-roles";
import ShellUtilities from "./ShellUtilities";

interface LayoutProps {
  children: ReactNode;
  width?: "reading" | "compact" | "standard" | "wide";
}

/** 账户设置区外壳：侧栏展开设置子项；管理员在底部看到管理入口。 */
export default function Layout({ children, width = "reading" }: LayoutProps) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate("/login");
  };

  const user = session?.user as { role?: string } | undefined;
  const isAdmin = canAccessAdmin(user?.role);

  return (
    <AppShell
      brand={<Link to="/settings">CQU Auth</Link>}
      navigation={
        <>
          <span className="ds-nav-label">设置</span>
          <RouterNavLink to="/settings" end>
            <UserRound aria-hidden="true" />
            账户设置
          </RouterNavLink>
          <RouterNavLink to="/settings/email">
            <Mail aria-hidden="true" />
            修改邮箱
          </RouterNavLink>
          <RouterNavLink to="/settings/two-factor">
            <KeyRound aria-hidden="true" />
            二次验证
          </RouterNavLink>
          {isAdmin && (
            <>
              <span className="ds-nav-label">管理</span>
              <RouterNavLink to="/admin">
                <LayoutDashboard aria-hidden="true" />
                管理控制台
              </RouterNavLink>
            </>
          )}
        </>
      }
      utilities={<ShellUtilities onSignOut={handleSignOut} />}
    >
      <ContentContainer width={width}>{children}</ContentContainer>
    </AppShell>
  );
}
