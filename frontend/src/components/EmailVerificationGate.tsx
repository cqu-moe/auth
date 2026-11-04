import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
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

function ExternalRedirect({ url, showPending }: { url: string; showPending: boolean }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);

  return showPending ? <SessionPending message="正在返回发起登录的应用…" /> : null;
}

export default function EmailVerificationGate({ children }: EmailVerificationGateProps) {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const location = useLocation();

  const publicEntry = publicEntryPaths.has(location.pathname);
  const emailStep = location.pathname === "/verify-email";
  const redirect = getEmailVerificationRedirect({
    hasSession: Boolean(session),
    emailVerified: session?.user.emailVerified === true,
    pathname: location.pathname,
  });
  // Only retain a public form already shown at this location. A guard redirect
  // on a cold visit must never mount the protected destination underneath it.
  const lastPublicEntry = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!redirect && (publicEntry || (emailStep && !isPending && !error))) {
      lastPublicEntry.current = location.key;
    }
  }, [location.key, publicEntry, emailStep, redirect, isPending, error]);

  if (location.pathname === "/") return <>{children}</>;

  if (isPending) {
    return publicEntry || (emailStep && session && lastPublicEntry.current === location.key)
      ? <>{children}</> : <SessionPending />;
  }

  if (error && error.status !== 401 && !session && !publicEntry) {
    return (
      <div className={emailStep ? "" : "flex min-h-dvh items-center justify-center bg-background p-6"}>
        <div className="w-full max-w-sm">
          <PageState state="error" title="暂时无法确认登录状态" description="请检查网络连接后重试。"
            action={<Button onClick={() => void refetch()}>重新加载</Button>} />
        </div>
      </div>
    );
  }

  if (redirect) {
    const keepForm = (publicEntry || emailStep) && lastPublicEntry.current === location.key;
    const target = redirect === "/verify-email"
      ? withRedirectParam(redirect, verificationContinuation(location.pathname, location.search))
      : postLoginRedirectFromSearch(location.search) ?? redirect;
    return <>
      {keepForm ? children : null}
      {isExternalHttpTarget(target)
        ? <ExternalRedirect url={target} showPending={!keepForm} />
        : <Navigate to={target} replace />}
    </>;
  }

  return <>{children}</>;
}
