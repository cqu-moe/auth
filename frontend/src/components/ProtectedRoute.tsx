import AdminAuthentication from "./AdminAuthentication";
import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { PageState } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import { canAccessAdmin } from "../../../shared/user-roles";
import { protectedLoginUrl } from "../lib/cqu-bind-continuation";

interface ProtectedRouteProps {
  children: ReactNode;
  requireAdmin?: boolean;
}

export default function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <PageState state="loading" title="正在验证访问权限" description="正在确认登录状态…" />
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to={protectedLoginUrl(location.pathname, location.search)} replace />;
  }

  if (requireAdmin) {
    const user = session.user as { role?: string };
    if (!canAccessAdmin(user.role)) {
      return <Navigate to="/settings" replace />;
    }
  }

  return requireAdmin ? <AdminAuthentication>{children}</AdminAuthentication> : <>{children}</>;
}
