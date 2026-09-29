import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { PageState } from "@cqu-moe/ui";
import { authClient } from "./lib/auth-client";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ResetPassword from "./pages/ResetPassword";
import ResetPasswordConfirm from "./pages/ResetPasswordConfirm";
import Settings from "./pages/Settings";
import ChangeEmail from "./pages/ChangeEmail";
import OAuthAuthorize from "./pages/OAuthAuthorize";
import CquBindWizard from "./pages/CquBindWizard";
import VerifyEmail from "./pages/VerifyEmail";
import TwoFactorChallenge from "./pages/TwoFactorChallenge";
import TwoFactorSettings from "./pages/TwoFactorSettings";
import ProtectedRoute from "./components/ProtectedRoute";
import EmailVerificationGate from "./components/EmailVerificationGate";
import AuthError from "./pages/AuthError";
import AdminLayout, { AdminPage } from "./pages/Admin";
import { UsersSection } from "./features/admin/UsersSection";
import { EntitlementsSection } from "./features/admin/EntitlementsSection";
import { InvitationsSection } from "./features/admin/InvitationsSection";
import { OAuthClientsSection } from "./features/admin/OAuthClientsSection";
import { syncPostHogIdentity, syncPostHogReplay } from "./lib/posthog";

function PostHogLifecycle() {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (isPending) return;
    const currentUserId = (session?.user as { id?: string } | undefined)?.id ?? null;
    syncPostHogIdentity(previousUserId.current, currentUserId);
    previousUserId.current = currentUserId;
  }, [isPending, session]);

  useEffect(() => {
    syncPostHogReplay(location.pathname);
  }, [location.pathname]);

  return null;
}

function RootRedirect() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <PageState state="loading" title="正在进入" description="正在确认登录状态…" />
        </div>
      </div>
    );
  }

  return <Navigate to={session ? "/settings" : "/login"} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <PostHogLifecycle />
      <EmailVerificationGate>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/reset-password/confirm" element={<ResetPasswordConfirm />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/two-factor" element={<TwoFactorChallenge />} />
          <Route path="/auth/error" element={<AuthError />} />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/email"
            element={
              <ProtectedRoute>
                <ChangeEmail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/two-factor"
            element={
              <ProtectedRoute>
                <TwoFactorSettings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute requireAdmin>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/admin/users" replace />} />
            <Route
              path="users"
              element={
                <AdminPage title="用户管理" description="查看用户、调整角色与封禁状态。">
                  <UsersSection />
                </AdminPage>
              }
            />
            <Route
              path="presets"
              element={
                <AdminPage title="权益预设" description="维护能力预设与新用户默认权益。">
                  <EntitlementsSection />
                </AdminPage>
              }
            />
            <Route
              path="invitations"
              element={
                <AdminPage title="注册邀请" description="生成与管理注册邀请码。">
                  <InvitationsSection />
                </AdminPage>
              }
            />
            <Route
              path="oauth"
              element={
                <AdminPage title="OAuth 客户端" description="管理第三方应用的 OAuth 接入。">
                  <OAuthClientsSection />
                </AdminPage>
              }
            />
          </Route>
          <Route
            path="/oauth/authorize"
            element={
              <ProtectedRoute>
                <OAuthAuthorize />
              </ProtectedRoute>
            }
          />
          <Route
            path="/cqu/bind"
            element={
              <ProtectedRoute>
                <CquBindWizard />
              </ProtectedRoute>
            }
          />
        </Routes>
      </EmailVerificationGate>
    </BrowserRouter>
  );
}
