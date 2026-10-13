import AdminAuthentication from "./AdminAuthentication";
import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import SessionPending from "./SessionPending";
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

  if (isPending) return <SessionPending />;

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
