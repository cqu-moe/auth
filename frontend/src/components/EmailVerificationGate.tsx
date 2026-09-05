import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { getEmailVerificationRedirect } from "../lib/email-verification-routing";

interface EmailVerificationGateProps {
  children: ReactNode;
}

export default function EmailVerificationGate({ children }: EmailVerificationGateProps) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const user = session?.user as { emailVerified?: boolean } | undefined;
  const redirect = getEmailVerificationRedirect({
    hasSession: Boolean(session),
    emailVerified: user?.emailVerified === true,
    pathname: location.pathname,
  });

  if (redirect) {
    return <Navigate to={redirect} replace />;
  }

  return <>{children}</>;
}
