import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import FullPageSpinner from "./FullPageSpinner";

interface ProtectedRouteProps {
  children: ReactNode;
  requireAdmin?: boolean;
}

export default function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <FullPageSpinner />;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (requireAdmin) {
    const user = session.user as { role?: string };
    if (user.role !== "admin" && user.role !== "superAdmin") {
      return <Navigate to="/dashboard" replace />;
    }
  }

  return <>{children}</>;
}
