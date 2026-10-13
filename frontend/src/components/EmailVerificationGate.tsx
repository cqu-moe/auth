import { ReactNode, useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Button, PageState } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import { getEmailVerificationRedirect } from "../lib/email-verification-routing";
import {
  isExternalHttpTarget,
  postLoginRedirectFromSearch,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { verificationContinuation } from "../lib/cqu-bind-continuation";

import SessionPending from "./SessionPending";

// Public forms stay mounted during signed-out session refetches (e.g. login).
const publicEntryPaths = new Set([
  "/login", "/register", "/reset-password", "/reset-password/confirm",
  "/two-factor", "/auth/error",
]);

interface EmailVerificationGateProps {
  children: ReactNode;
}

function ExternalRedirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);

  return <SessionPending message="正在返回发起登录的应用…" />;
}

export default function EmailVerificationGate({ children }: EmailVerificationGateProps) {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const location = useLocation();

  if (isPending) {
    return publicEntryPaths.has(location.pathname) ? <>{children}</> : <SessionPending />;
  }

  if (error && error.status !== 401 && !session && !publicEntryPaths.has(location.pathname)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <PageState state="error" title="暂时无法确认登录状态" description="请检查网络连接后重试。"
            action={<Button onClick={() => void refetch()}>重新加载</Button>} />
        </div>
      </main>
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
      const target = verificationContinuation(location.pathname, location.search);
      return <Navigate to={withRedirectParam("/verify-email", target)} replace />;
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
