import { ReactNode, useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { PageState } from "@cqu-moe/ui";
import { authClient } from "../lib/auth-client";
import { getEmailVerificationRedirect } from "../lib/email-verification-routing";
import {
  isExternalHttpTarget,
  postLoginRedirectFromSearch,
  withRedirectParam,
} from "../lib/post-login-redirect";
import { verificationContinuation } from "../lib/cqu-bind-continuation";

interface EmailVerificationGateProps {
  children: ReactNode;
}

function ExternalRedirect({ url }: { url: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <PageState state="loading" title="正在跳转" description="即将返回发起登录的应用…" />
      </div>
    </div>
  );
}

export default function EmailVerificationGate({ children }: EmailVerificationGateProps) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <PageState state="loading" title="正在检查邮箱验证状态" description="正在确认登录状态…" />
        </div>
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
