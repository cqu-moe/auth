import { ReactNode, useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { getEmailVerificationRedirect } from "../lib/email-verification-routing";
import {
  isExternalHttpTarget,
  postLoginRedirectFromSearch,
} from "../lib/post-login-redirect";

interface EmailVerificationGateProps {
  children: ReactNode;
}

function ExternalRedirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
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
    if (redirect === "/verify-email") {
      // Keep ?redirect=... so the return target survives the gate bounce.
      return <Navigate to={{ pathname: "/verify-email", search: location.search }} replace />;
    }
    if (redirect === "/settings") {
      // A verified user leaving the verification page continues the round
      // trip to the app that started the login, if any.
      const target = postLoginRedirectFromSearch(location.search);
      if (target) {
        return isExternalHttpTarget(target) ? (
          <ExternalRedirect url={target} />
        ) : (
          <Navigate to={target} replace />
        );
      }
    }
    return <Navigate to={redirect} replace />;
  }

  return <>{children}</>;
}
