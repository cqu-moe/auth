import { ReactNode } from "react";
import { Link, NavLink as RouterNavLink, useNavigate } from "react-router-dom";
import { Fingerprint, LayoutDashboard, Link2, ShieldCheck, UserRound } from "lucide-react";
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
      brand={<Link to="/settings" className="auth-brand"><Fingerprint aria-hidden="true" />CQU Auth</Link>}
      navigation={
        <>
          <span className="ds-nav-label">设置</span>
          <RouterNavLink to="/settings" end>
            <UserRound aria-hidden="true" />
            账户
          </RouterNavLink>
          <RouterNavLink to="/settings/security">
            <ShieldCheck aria-hidden="true" />
            安全
          </RouterNavLink>
          <RouterNavLink to="/settings/cqu">
            <Link2 aria-hidden="true" />
            CQU 集成
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
