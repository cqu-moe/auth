import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { authClient } from "../lib/auth-client";

interface ProtectedRouteProps {
  children: ReactNode;
  requireAdmin?: boolean;
}

export default function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (requireAdmin) {
    const user = session.user as { role?: string };
    if (user.role !== "admin" && user.role !== "superAdmin") {
      return <Navigate to="/settings" replace />;
    }
  }

  return <>{children}</>;
}
